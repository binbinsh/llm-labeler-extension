import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { db, DEFAULT_SETTINGS } from "../db";
import type {
  BackgroundMessage,
  BackgroundResponse,
  QueueItem,
  Sample,
  StatsSnapshot,
  ResultRecord,
  OutputCountMode
} from "../shared/types";
import { DEFAULT_PROMPT } from "../shared/defaultPrompt";
import "./styles.css";

type ImportLog = { level: "info" | "error"; message: string };

type ImportCandidate = {
  file: File;
  isGzip: boolean;
  eligibleCount: number;
  keys: string[];
};

const RECOMMENDED_INPUT_KEYS = [
  "input_text",
  "inputText",
  "text",
  "input",
  "instruction",
  "prompt",
  "question",
  "query",
  "content"
];

function buildDefaultInputKeys(detectedKeys: string[], savedKeys: string[]) {
  const detected = new Set(detectedKeys);
  const next: string[] = [];
  const pushUnique = (key: string) => {
    if (!next.includes(key)) next.push(key);
  };

  if (detected.has("id")) pushUnique("id");
  if (detected.has("input_text")) {
    pushUnique("input_text");
  } else {
    const fallback = RECOMMENDED_INPUT_KEYS.find((k) => detected.has(k));
    if (fallback) pushUnique(fallback);
  }

  for (const key of savedKeys) {
    if (detected.has(key)) pushUnique(key);
  }

  if (next.length === 1 && next[0] === "id") {
    const fallback =
      RECOMMENDED_INPUT_KEYS.find((k) => k !== "id" && detected.has(k)) ??
      detectedKeys.find((k) => k !== "id");
    if (fallback) pushUnique(fallback);
  }

  if (!next.length) return detectedKeys.length ? [detectedKeys[0]] : [];
  return next;
}

async function sendToBackground(msg: BackgroundMessage): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: BackgroundResponse) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(res);
      }
    });
  });
}

export function App() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<StatsSnapshot>({
    pending: 0,
    inflight: 0,
    done: 0,
    error: 0,
    running: false
  });
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preparingImport, setPreparingImport] = useState(false);
  const [imported, setImported] = useState(0);
  const [importCandidate, setImportCandidate] = useState<ImportCandidate | null>(null);
  const [importKeySelection, setImportKeySelection] = useState<string[]>([]);
  const [importKeyFilter, setImportKeyFilter] = useState("");
  const [logs, setLogs] = useState<ImportLog[]>([]);
  const [detectedTarget, setDetectedTarget] = useState<string>("Not detected");
  const [lastFileName, setLastFileName] = useState<string>("");
  const [recentResults, setRecentResults] = useState<ResultRecord[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [retryingErrors, setRetryingErrors] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    (async () => {
      const savedPrompt = await db.prompts.get("active");
      if (savedPrompt && typeof savedPrompt.prompt === "string") {
        setPrompt(savedPrompt.prompt);
      }
      const savedSettings = await db.settings.get("active");
      if (savedSettings) {
        setSettings({
          id: "active",
          responseDelayMs: savedSettings.responseDelayMs ?? DEFAULT_SETTINGS.responseDelayMs,
          batchSize: savedSettings.batchSize ?? DEFAULT_SETTINGS.batchSize,
          inputKeys: Array.isArray(savedSettings.inputKeys)
            ? savedSettings.inputKeys.filter((k) => typeof k === "string")
            : DEFAULT_SETTINGS.inputKeys,
          samplePercent: Math.min(
            100,
            Math.max(1, savedSettings.samplePercent ?? DEFAULT_SETTINGS.samplePercent)
          ),
          outputCountMode: savedSettings.outputCountMode ?? DEFAULT_SETTINGS.outputCountMode,
          updatedAt: Date.now()
        });
      }
      refreshStats();
      detectTarget();
      refreshPreview();
    })();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      refreshStats();
      detectTarget();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    adjustPromptHeight();
  }, [prompt]);

  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      return;
    }
    const timer = setTimeout(() => {
      persistPrompt(prompt);
    }, 400);
    return () => clearTimeout(timer);
  }, [prompt]);

  const appendLog = (entry: ImportLog) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.slice(-500);
    });
  };

  const clearLog = () => setLogs([]);

  const saveLog = () => {
    if (logs.length === 0) return;
    const blob = new Blob([logs.map((l) => `[${l.level}] ${l.message}`).join("\n")], {
      type: "text/plain"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "llm-labeler-log.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  async function refreshStats() {
    try {
      const res = await sendToBackground({ type: "stats:request" });
      if (res.ok && res.type === "stats:request") {
        setStats(res.stats);
        if (typeof res.stats.running === "boolean") {
          setRunning(res.stats.running);
        }
      }
    } catch (err) {
      console.warn("stats error", err);
    }
  }

  async function detectTarget() {
    try {
      const res = await sendToBackground({ type: "detect:target" });
      const target = (res as any).target as string | undefined;
      if (res.ok && target) {
        const label =
          target === "gemini" ? "Gemini" : target === "chatgpt" ? "ChatGPT" : target;
        setDetectedTarget(label);
      } else {
        setDetectedTarget("Not detected");
      }
    } catch {
      setDetectedTarget("Not detected");
    }
  }

  async function persistPrompt(currentPrompt: string) {
    await db.prompts.put({ id: "active", prompt: currentPrompt, updatedAt: Date.now() });
    await sendToBackground({ type: "prompt:update", prompt: currentPrompt });
  }

  const adjustPromptHeight = () => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(180, el.scrollHeight)}px`;
  };

  async function refreshPreview() {
    setPreviewLoading(true);
    try {
      const rows = await db.results.orderBy("createdAt").reverse().limit(20).toArray();
      setRecentResults(rows);
    } catch (err: any) {
      appendLog({
        level: "error",
        message: `Preview load failed: ${err?.message || err}`
      });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function retryErrors() {
    setRetryingErrors(true);
    try {
      const errors = await db.queue.where("status").equals("error").toArray();
      if (!errors.length) {
        appendLog({ level: "info", message: "No error items to retry." });
        return;
      }
      const now = Date.now();
      await Promise.all(
        errors.map((item) =>
          db.queue.update(item.id, {
            status: "pending",
            lastError: null,
            retries: (item.retries || 0) + 1,
            updatedAt: now
          })
        )
      );
      appendLog({ level: "info", message: `Retried ${errors.length} error item(s).` });
      await refreshStats();
      await refreshPreview();
    } catch (err: any) {
      appendLog({ level: "error", message: `Retry failed: ${err?.message || err}` });
    } finally {
      setRetryingErrors(false);
    }
  }

  async function handleStart() {
    appendLog({ level: "info", message: "Start requested" });
    await persistPrompt(prompt);
    const res = await sendToBackground({
      type: "control:start",
      settings: {
        responseDelayMs: settings.responseDelayMs,
        batchSize: settings.batchSize,
        inputKeys: settings.inputKeys,
        samplePercent: settings.samplePercent,
        outputCountMode: settings.outputCountMode
      }
    });
    if (res.ok) {
      setRunning(true);
      appendLog({ level: "info", message: "Dispatcher started" });
    }
  }

  async function handlePause() {
    appendLog({ level: "info", message: "Pause requested" });
    const res = await sendToBackground({ type: "control:pause" });
    if (res.ok) {
      setRunning(false);
      appendLog({ level: "info", message: "Dispatcher paused" });
    }
  }

  async function handleExport() {
    const results = await db.results.toArray();
    const exportName = buildExportName(lastFileName);
    const lines = results.map((r) =>
      JSON.stringify({
        id: r.id,
        sampleId: r.sampleId,
        target: r.target,
        ok: r.ok,
        error: r.error,
        parsed: r.parsed,
        rawResponse: r.rawResponse
      })
    );
    const blob = new Blob([lines.join("\n")], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportName;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleClearQueue() {
    const ok = window.confirm("Clear queue and results? Prompts/settings will be kept.");
    if (!ok) return;
    await db.queue.clear();
    await db.results.clear();
    setLogs([]);
    setImported(0);
    setLastFileName("");
    setStats({ pending: 0, inflight: 0, done: 0, error: 0 });
    await refreshStats();
    appendLog({ level: "info", message: "Cleared queue and results." });
  }

  const analyzeImportFile = (file: File, isGzip: boolean) =>
    new Promise<{ eligibleCount: number; keys: string[] }>((resolve, reject) => {
      const worker = new Worker(new URL("../workers/stream-jsonl.ts", import.meta.url), {
        type: "module"
      });
      let eligibleCount = 0;
      let keys: string[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        fn();
      };
      worker.onmessage = (ev) => {
        const data = ev.data;
        if (data.type === "analysis") {
          eligibleCount = Number(data.count) || 0;
          keys = Array.isArray(data.keys)
            ? (data.keys as unknown[]).filter((k: unknown): k is string => typeof k === "string")
            : [];
        } else if (data.type === "error") {
          finish(() => reject(new Error(data.error || "analyze_failed")));
        } else if (data.type === "done") {
          finish(() => resolve({ eligibleCount, keys }));
        }
      };
      worker.onerror = (err) => finish(() => reject(err));
      worker.postMessage({ file, isGzip, mode: "analyze" });
    });

  async function prepareImport(file: File) {
    if (importing || preparingImport) return;
    setPreparingImport(true);
    setImportCandidate(null);
    setImportKeySelection([]);
    setImportKeyFilter("");

    appendLog({ level: "info", message: `Analyzing ${file.name} for JSON keys...` });
    const isGzip = file.name.endsWith(".gz");
    try {
      const analysis = await analyzeImportFile(file, isGzip);
      if (analysis.eligibleCount <= 0) {
        appendLog({ level: "info", message: "No non-empty lines found. Nothing to import." });
        return;
      }
      const candidate: ImportCandidate = {
        file,
        isGzip,
        eligibleCount: analysis.eligibleCount,
        keys: analysis.keys
      };
      if (!candidate.keys.length) {
        appendLog({
          level: "info",
          message: "No JSON object keys detected; importing with raw line fallback."
        });
        setPreparingImport(false);
        await handleFile(candidate, settings.inputKeys);
        return;
      }
      setImportCandidate(candidate);
      setImportKeySelection(buildDefaultInputKeys(candidate.keys, settings.inputKeys));
      appendLog({
        level: "info",
        message: `Detected ${candidate.keys.length} key(s) from ${candidate.eligibleCount} line(s). Select which values to include.`
      });
    } catch (err: any) {
      appendLog({ level: "error", message: `Analyze failed: ${err?.message || err}` });
    } finally {
      setPreparingImport(false);
    }
  }

  async function startPreparedImport() {
    if (!importCandidate) return;
    const selectedKeys = importKeySelection.filter((k) => importCandidate.keys.includes(k));
    if (!selectedKeys.length) {
      appendLog({ level: "error", message: "Select at least one key to import." });
      return;
    }
    const now = Date.now();
    const nextSettings = { ...settings, inputKeys: selectedKeys, updatedAt: now };
    setSettings(nextSettings);
    try {
      await db.settings.put({ ...nextSettings, id: "active" });
    } catch (err: any) {
      appendLog({ level: "error", message: `Failed to persist settings: ${err?.message || err}` });
    }
    const candidate = importCandidate;
    setImportCandidate(null);
    setImportKeySelection([]);
    setImportKeyFilter("");
    await handleFile(candidate, selectedKeys);
  }

  function cancelPreparedImport() {
    setImportCandidate(null);
    setImportKeySelection([]);
    setImportKeyFilter("");
  }

  async function handleFile(candidate: ImportCandidate, inputKeys: string[]) {
    setImporting(true);
    setImported(0);
    appendLog({ level: "info", message: `Importing ${candidate.file.name}...` });
    const { file, isGzip } = candidate;
    const samplePercent = Math.min(
      100,
      Math.max(1, Number(settings.samplePercent) || DEFAULT_SETTINGS.samplePercent)
    );
    const shouldSample = samplePercent < 100;

    let baseSeq = 0;
    try {
      const last = await db.queue.orderBy("seq").last();
      baseSeq = typeof last?.seq === "number" ? last.seq + 1 : 0;
    } catch {
      baseSeq = 0;
    }

    const totalEligible = candidate.eligibleCount;
    let targetEligible = 0;
    if (shouldSample) {
      if (totalEligible <= 0) {
        setImporting(false);
        appendLog({ level: "info", message: "No non-empty lines found. Nothing queued." });
        return;
      }
      targetEligible = Math.round((totalEligible * samplePercent) / 100);
      targetEligible = Math.min(totalEligible, Math.max(1, targetEligible));
      appendLog({
        level: "info",
        message: `Sampling ${samplePercent}%: will enqueue ${targetEligible}/${totalEligible} line(s).`
      });
    }

    const worker = new Worker(new URL("../workers/stream-jsonl.ts", import.meta.url), {
      type: "module"
    });
    let buffer: QueueItem[] = [];
    let totalQueued = 0;
    let seen = 0;
    let skipped = 0;
    let failed = 0;
    let created = 0;
    let sampledOut = 0;
    let sampledIn = 0;
    let flushing = false;
    const flush = async () => {
      if (flushing) return;
      flushing = true;
      while (buffer.length > 0) {
        const chunk = buffer.splice(0, buffer.length);
        const count = chunk.length;
        try {
          await db.queue.bulkPut(chunk);
          totalQueued += count;
          setImported((c) => c + count);
          appendLog({
            level: "info",
            message: `Flushed ${count} queued samples (this import total ${totalQueued})`
          });
          await refreshStats();
          await sendToBackground({ type: "queue:flush" });
        } catch (err: any) {
          appendLog({
            level: "error",
            message: `Failed to flush queue: ${err?.message || err}`
          });
        }
      }
      flushing = false;
    };

    worker.onmessage = async (ev) => {
      const data = ev.data;
      if (data.type === "line") {
        try {
          const rawLine: string = data.line;
          if (!rawLine.trim()) {
            skipped += 1;
            return;
          }
          seen += 1;
          if (shouldSample) {
            const need = targetEligible - sampledIn;
            const remainingIncludingCurrent = totalEligible - seen + 1;
            let take = false;
            if (need <= 0) {
              take = false;
            } else if (need >= remainingIncludingCurrent) {
              take = true;
            } else {
              take = Math.random() < need / remainingIncludingCurrent;
            }
            if (!take) {
              sampledOut += 1;
              return;
            }
            sampledIn += 1;
          }
          const now = Date.now();
          const extracted = extractSampleText(rawLine, inputKeys);
          const id: string = extracted.sampleId?.trim() || generateId(now);
          const normalizedSample: Sample = { id, text: extracted.text };
          if (extracted.source !== "raw") {
            normalizedSample.meta = { source: extracted.source };
          }
          const promptPayload: Record<string, unknown> = { id, ...extracted.payload };
          const promptForSample = JSON.stringify(promptPayload);
          buffer.push({
            id,
            seq: baseSeq + (seen - 1),
            prompt: promptForSample,
            sample: normalizedSample,
            status: "pending",
            target: "auto",
            retries: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now
          });
          created += 1;
          if (buffer.length >= 200) await flush();
        } catch (err: any) {
          failed += 1;
          appendLog({
            level: "error",
            message: `normalize/build prompt failed: ${err?.message || err}`
          });
        }
      } else if (data.type === "error") {
        appendLog({ level: "error", message: `Stream error: ${data.error}` });
      } else if (data.type === "done") {
        await flush();
        setImporting(false);
        appendLog({
          level: "info",
          message: shouldSample
            ? `File processing completed. Seen ${seen}, sampled ${sampledIn}/${totalEligible}, created ${created}, queued ${totalQueued}, sampled-out ${sampledOut}, skipped ${skipped}, failed ${failed}.`
            : `File processing completed. Seen ${seen}, created ${created}, queued ${totalQueued}, skipped ${skipped}, failed ${failed}.`
        });
        worker.terminate();
      }
    };

    worker.postMessage({ file, isGzip, mode: "stream" });
  }

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setLastFileName(file.name);
      prepareImport(file);
      e.target.value = "";
    }
  };

  return (
    <div className="page">
      <header className="header">
        <div className="header-left">
          <div className="title-row">
            <h1>LLM Labeler</h1>
            <div className="status">
              <span className={`dot ${running ? "on" : "off"}`} />
              {running ? "Running" : "Paused"}
            </div>
          </div>
          <p>Each batch sends your prompt plus samples.</p>
        </div>
      </header>

      <section className="card">
        <div className="card-header">
          <h2>Controls</h2>
          <div className="actions">
            <button onClick={handleClearQueue}>Clear queue/results</button>
            <button onClick={retryErrors} disabled={retryingErrors}>
              {retryingErrors ? "Retrying..." : "Retry errors"}
            </button>
            <button onClick={handleExport}>Export results</button>
            <button onClick={running ? handlePause : handleStart}>
              {running ? "Pause processing" : "Start processing"}
            </button>
          </div>
        </div>
        <div className="grid">
          <label className="field">
            <span>Detected target</span>
            <input type="text" value={detectedTarget} readOnly />
            <small>Auto-detect from current tab URL (Gemini / ChatGPT)</small>
          </label>
          <label className="field">
            <span>Wait after reply (seconds)</span>
            <input
              type="number"
              min={0}
              value={Math.round(settings.responseDelayMs / 1000)}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  responseDelayMs: Number(e.target.value) * 1000
                }))
              }
            />
            <small>Delay after assistant finishes before next sample</small>
          </label>
          <label className="field">
            <span>Batch size</span>
            <input
              type="number"
              min={1}
              value={settings.batchSize}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  batchSize: Number(e.target.value) || 1
                }))
              }
            />
            <small>Number of samples per prompt</small>
          </label>
          <label className="field">
            <span>Sampling (%)</span>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={settings.samplePercent}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  samplePercent:
                    e.target.value === ""
                      ? DEFAULT_SETTINGS.samplePercent
                      : Math.min(100, Math.max(1, Number(e.target.value) || 1))
                }))
              }
            />
            <small>Applies on import. 100 keeps all lines; lower values randomly sample.</small>
          </label>
          <label className="field">
            <span>Output count rule</span>
            <select
              value={settings.outputCountMode}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  outputCountMode: e.target.value as OutputCountMode
                }))
              }
            >
              <option value="match_input">Match input count (strict)</option>
              <option value="allow_mismatch">Allow mismatch (no errors)</option>
            </select>
            <small>
              Match input count: Expects one output item per input sample. If a reply contains fewer
              results than inputs, the missing samples are marked as errors. Allow mismatch: If the
              reply count differs from the input count (or cannot be mapped 1:1), the entire reply
              is treated as a single batch-level result and saved once (with the batch sample IDs);
              no errors are raised for count mismatch.
            </small>
          </label>
        </div>
        <div className="stats">
          <Stat label="Pending" value={stats.pending} />
          <Stat label="In-flight" value={stats.inflight} />
          <Stat label="Done" value={stats.done} />
          <Stat label="Error" value={stats.error} />
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Import</h2>
        </div>
        <div className="field">
          <span>Import file</span>
          <div className="file-picker">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing || preparingImport || Boolean(importCandidate)}
            >
              Choose file
            </button>
            <span className="file-name">{lastFileName || "No file selected"}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jsonl,.gz,.jsonl.gz"
              onChange={handleFileInput}
              disabled={importing || preparingImport || Boolean(importCandidate)}
              style={{ display: "none" }}
            />
          </div>
          <small>Supports jsonl / jsonl.gz (streamed + gunzip)</small>
          {importing && <div className="pill">Importing... queued {imported}</div>}
          {preparingImport && <div className="pill">Analyzing...</div>}
          {importCandidate && (
            <div className="key-panel">
              <div className="key-panel-head">
                <div className="key-panel-title">Choose keys to include</div>
                <div className="muted">
                  Selected {importKeySelection.length} / {importCandidate.keys.length} (from{" "}
                  {importCandidate.eligibleCount} line(s))
                </div>
              </div>
              <input
                className="key-filter"
                type="text"
                placeholder="Filter keys..."
                value={importKeyFilter}
                onChange={(e) => setImportKeyFilter(e.target.value)}
              />
              <div className="key-list">
                {importCandidate.keys
                  .filter((k) =>
                    k.toLowerCase().includes(importKeyFilter.trim().toLowerCase())
                  )
                  .map((key) => {
                    const checked = importKeySelection.includes(key);
                    return (
                      <label key={key} className="key-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const nextChecked = e.target.checked;
                            setImportKeySelection((prev) => {
                              if (nextChecked) return prev.includes(key) ? prev : [...prev, key];
                              return prev.filter((k) => k !== key);
                            });
                          }}
                        />
                        <span className="key-name">{key}</span>
                      </label>
                    );
                  })}
              </div>
              <div className="key-actions">
                <button type="button" onClick={() => setImportKeySelection(importCandidate.keys)}>
                  Select all
                </button>
                <button type="button" onClick={() => setImportKeySelection([])}>
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setImportKeySelection(
                      buildDefaultInputKeys(importCandidate.keys, settings.inputKeys)
                    )
                  }
                >
                  Reset
                </button>
                <button type="button" onClick={cancelPreparedImport}>
                  Cancel
                </button>
                <button type="button" onClick={startPreparedImport}>
                  Start import
                </button>
              </div>
              <small>
                Each sample will be sent as JSON containing <code>id</code> plus the selected keys
                (values are preserved; missing keys are omitted).
              </small>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Prompt</h2>
          <div className="actions">
            <button type="button" onClick={() => setPrompt(DEFAULT_PROMPT)}>
              Reset to default
            </button>
          </div>
        </div>
        <p className="muted">
          Each call sends this prompt plus the raw batch (newline-joined). Keep replies as a JSON
          array of <code>{'{'}"id","output_text"{'}'}</code> objects. Prompt auto-saves as you type
          (clearing it stays empty and is allowed). Leave it empty to send only the samples. Use
          <b>Reset to default</b> to restore the built-in template.
        </p>
        <textarea
          className="prompt-input"
          rows={10}
          value={prompt}
          ref={promptRef}
          onChange={(e) => {
            setPrompt(e.target.value);
            adjustPromptHeight();
          }}
          onInput={adjustPromptHeight}
        />
        <div className="muted">
          Each sample is sent as JSON (e.g. <code>{'{'}"id": "...", "input_text": "..."{'}'}</code>),
          joined with <code>\n</code>. On import, you can choose which JSON keys to include (e.g.{" "}
          <code>output_text</code> stays as <code>output_text</code> instead of being merged into{" "}
          <code>input_text</code>).
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Logs</h2>
          <div className="actions">
            <button onClick={saveLog} disabled={logs.length === 0}>
              Save log
            </button>
            <button onClick={clearLog}>Clear log</button>
          </div>
        </div>
        <div className="log">
          {logs.length === 0 && <div className="muted">No logs yet</div>}
          {logs.map((log, idx) => (
            <div key={idx} className={`log-line ${log.level}`}>
              {log.message}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Recent results (latest 20 as JSONL)</h2>
          <div className="actions">
            <button onClick={refreshPreview} disabled={previewLoading}>
              {previewLoading ? "Loading..." : "Refresh preview"}
            </button>
          </div>
        </div>
        {recentResults.length === 0 ? (
          <div className="muted">No results yet</div>
        ) : (
          <div className="preview-table">
            <div className="preview-row preview-head">
              <div className="preview-cell">JSONL</div>
              <div className="preview-cell meta">Status</div>
              <div className="preview-cell meta">Created</div>
            </div>
            {recentResults.map((r) => {
              const line = JSON.stringify({
                id: r.id,
                sampleId: r.sampleId,
                target: r.target,
                ok: r.ok,
                error: r.error,
                parsed: r.parsed,
                createdAt: r.createdAt
              });
              return (
                <div key={r.id} className="preview-row">
                  <div className="preview-cell code">
                    <code>{line}</code>
                  </div>
                  <div className="preview-cell meta">
                    {r.ok ? "ok" : `error: ${r.error || "unknown"}`}
                  </div>
                  <div className="preview-cell meta">{formatTime(r.createdAt)}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function buildSamplePrompt(id: string, line: string) {
  const text = line.trim();
  return JSON.stringify({ id, input_text: text || "" });
}

type SampleTextSource = "input_text" | "inputText" | "text" | "keys" | "raw";

function extractSampleText(
  rawLine: string,
  inputKeys?: string[]
): {
  text: string;
  source: SampleTextSource;
  sampleId?: string;
  payload: Record<string, unknown>;
} {
  const trimmed = rawLine.trim();
  if (!trimmed) return { text: "", source: "raw", payload: { input_text: "" } };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const idCandidate =
        (parsed as Record<string, unknown>).id ??
        (parsed as Record<string, unknown>).sampleId ??
        (parsed as Record<string, unknown>).sample_id;
      const parsedId =
        typeof idCandidate === "string"
          ? idCandidate.trim()
          : typeof idCandidate === "number"
            ? String(idCandidate)
            : undefined;
      const obj = parsed as Record<string, unknown>;
      const selected = Array.isArray(inputKeys)
        ? inputKeys.filter((k) => typeof k === "string" && k.trim() && k !== "id")
        : [];

      const payload: Record<string, unknown> = {};
      for (const key of selected) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          payload[key] = obj[key];
        }
      }

      let previewText: string | null = null;
      const previewCandidates: Array<"input_text" | "inputText" | "text"> = [
        "input_text",
        "inputText",
        "text"
      ];
      for (const k of previewCandidates) {
        if (typeof payload[k] === "string" && (payload[k] as string).trim()) {
          previewText = (payload[k] as string).trim();
          break;
        }
        if (typeof obj[k] === "string" && (obj[k] as string).trim()) {
          previewText = (obj[k] as string).trim();
          break;
        }
      }
      if (previewText == null) previewText = trimmed;

      if (Object.keys(payload).length) {
        return { text: previewText, source: "keys", sampleId: parsedId, payload };
      }

      // If selected keys are missing on this line, fall back to a best-effort text field or the raw line.
      for (const k of previewCandidates) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          payload[k] = obj[k];
          if (typeof obj[k] === "string" && (obj[k] as string).trim()) {
            previewText = (obj[k] as string).trim();
          }
          return { text: previewText, source: k, sampleId: parsedId, payload };
        }
      }
      return { text: previewText, source: "raw", sampleId: parsedId, payload: { input_text: trimmed } };
    }
  } catch {
    /* ignore parse errors and fall back to raw */
  }
  return { text: trimmed, source: "raw", payload: { input_text: trimmed } };
}

function generateId(now: number) {
  try {
    return crypto.randomUUID();
  } catch {
    return `${now}-${Math.random()}`;
  }
}

function buildExportName(fileName: string) {
  if (!fileName) return "llm-labeler-results.jsonl";
  const cleaned = fileName.replace(/\.gz$/i, "").replace(/\.jsonl$/i, "");
  return `${cleaned}_results.jsonl`;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}
