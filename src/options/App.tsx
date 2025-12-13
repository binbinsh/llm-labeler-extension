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
  const [imported, setImported] = useState(0);
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

  async function handleFile(file: File) {
    setImporting(true);
    setImported(0);
    appendLog({ level: "info", message: `Importing ${file.name}...` });
    const isGzip = file.name.endsWith(".gz");
    const worker = new Worker(
      new URL("../workers/stream-jsonl.ts", import.meta.url),
      { type: "module" }
    );
    let buffer: QueueItem[] = [];
    let totalQueued = 0;
    let seen = 0;
    let skipped = 0;
    let failed = 0;
    let created = 0;
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
        seen += 1;
        try {
          const rawLine: string = data.line;
          if (!rawLine.trim()) {
            skipped += 1;
            return;
          }
          const now = Date.now();
          const extracted = extractSampleText(rawLine);
          const id: string = extracted.sampleId?.trim() || generateId(now);
          const normalizedSample: Sample = { id, text: extracted.text };
          if (extracted.source !== "raw") {
            normalizedSample.meta = { source: extracted.source };
          }
          const promptForSample = buildSamplePrompt(id, extracted.text);
          buffer.push({
            id,
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
          message: `File processing completed. Seen ${seen}, created ${created}, queued ${totalQueued}, skipped ${skipped}, failed ${failed}.`
        });
        worker.terminate();
      }
    };

    worker.postMessage({ file, isGzip });
  }

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setLastFileName(file.name);
      handleFile(file);
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
          <div className="field">
            <span>Import file</span>
            <div className="file-picker">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                Choose file
              </button>
              <span className="file-name">
                {lastFileName || "No file selected"}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".jsonl,.gz,.jsonl.gz"
                onChange={handleFileInput}
                disabled={importing}
                style={{ display: "none" }}
              />
            </div>
            <small>Supports jsonl / jsonl.gz (streamed + gunzip)</small>
            {importing && <div className="pill">Importing... queued {imported}</div>}
          </div>
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
          Each sample stays as its raw jsonl line (e.g. <code>{'{'}"id": "...", "input_text": "..."{'}'}</code>), joined with <code>\n</code>.
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

type SampleTextSource = "input_text" | "inputText" | "text" | "raw";

function extractSampleText(
  rawLine: string
): { text: string; source: SampleTextSource; sampleId?: string } {
  const trimmed = rawLine.trim();
  if (!trimmed) return { text: "", source: "raw" };
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
      const keys: SampleTextSource[] = ["input_text", "inputText", "text"];
      for (const key of keys) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) {
          return { text: value.trim(), source: key, sampleId: parsedId };
        }
      }
      if (parsedId) {
        return { text: trimmed, source: "raw", sampleId: parsedId };
      }
    }
  } catch {
    /* ignore parse errors and fall back to raw */
  }
  return { text: trimmed, source: "raw" };
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
