import Dexie from "dexie";
import { db, DEFAULT_SETTINGS } from "../db";
import type {
  AutoTarget,
  BackgroundMessage,
  BackgroundResponse,
  QueueItem,
  SettingsDoc,
  StatsSnapshot,
  TargetSite
} from "../shared/types";
import { DEFAULT_PROMPT } from "../shared/defaultPrompt";

type TabChangeInfo = { status?: string };

const patterns: Record<TargetSite, string[]> = {
  gemini: ["https://gemini.google.com/*"],
  chatgpt: ["https://chatgpt.com/*"]
};

const injectedTabs = new Set<number>();
let lockedTarget: { tabId: number; target: TargetSite } | null = null;

async function ensureContentScript(tabId: number, target: TargetSite) {
  const hasListener = await new Promise<boolean>((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "ping" }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean((res as any)?.ok));
      });
    } catch {
      resolve(false);
    }
  });

  if (hasListener) {
    injectedTabs.add(tabId);
    return;
  }

  injectedTabs.delete(tabId);
  const file = `content/${target}.js`;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file]
    });
    injectedTabs.add(tabId);
    console.debug("[llm-labeler][bg] injected content script", file, "into tab", tabId);
  } catch (err: any) {
    console.warn("[llm-labeler][bg] inject failed", file, err?.message || err);
  }
}

const state: {
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  settings: SettingsDoc;
  prompt: string;
} = {
  running: false,
  timer: null,
  processing: false,
  settings: DEFAULT_SETTINGS,
  prompt: DEFAULT_PROMPT
};

function normalizePromptInput(prompt: unknown) {
  return typeof prompt === "string" ? prompt : DEFAULT_PROMPT;
}

const queryTabs = (query: chrome.tabs.QueryInfo) =>
  new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query(query, resolve));

const sendMessage = <T = any>(tabId: number, payload: any) =>
  new Promise<T>((resolve, reject) =>
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response as T);
    })
  );

async function detectTargetTab(): Promise<{ tabId: number; target: TargetSite } | null> {
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  const matchActive = activeTabs.find((t) =>
    t.url &&
    (Object.keys(patterns) as TargetSite[]).some((key) =>
      patterns[key].some((u) => t.url?.startsWith(u.replace("*", "")))
    )
  );
  if (matchActive?.id && matchActive.url) {
    const target = (Object.keys(patterns) as TargetSite[]).find((k) =>
      patterns[k].some((u) => matchActive.url?.startsWith(u.replace("*", "")))
    );
    if (target) return { tabId: matchActive.id, target };
  }

  for (const target of Object.keys(patterns) as TargetSite[]) {
    const hits = await queryTabs({ url: patterns[target] });
    if (hits.length && hits[0].id != null) {
      return { tabId: hits[0].id!, target };
    }
  }
  return null;
}

async function waitForTabComplete(tabId: number, timeoutMs = 15000) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (id: number, info: TabChangeInfo) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureTargetTab(): Promise<{ tabId: number; target: TargetSite } | null> {
  if (lockedTarget) {
    return lockedTarget;
  }
  const detected = await detectTargetTab();
  if (detected) {
    lockedTarget = detected;
    return detected;
  }

  // Default to Gemini if nothing is open.
  const created = await chrome.tabs.create({ url: "https://gemini.google.com/app" });
  if (created?.id != null) {
    await waitForTabComplete(created.id);
    enableSidePanel(created.id);
    lockedTarget = { tabId: created.id, target: "gemini" };
    return lockedTarget;
  }
  return null;
}

async function sendPromptToTab(
  tabId: number,
  prompt: string,
  sampleId: string
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  try {
    await sendMessage(tabId, { type: "ping" });
  } catch (err: any) {
    console.warn("[llm-labeler][bg] ping failed", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
  try {
    const res = await sendMessage(tabId, {
      type: "run_prompt",
      prompt,
      sampleId
    });
    return res as any;
  } catch (err: any) {
    console.warn("[llm-labeler][bg] sendMessage failed", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

function buildBatchPrompt(items: QueueItem[], prompt: string) {
  const trimmedPrompt = prompt.trim();
  const prefix = trimmedPrompt ? `${trimmedPrompt}\n\n` : "";
  const body = items
    .map((item) => (item.prompt || "").trim())
    .filter(Boolean)
    .join("\n");
  return `${prefix}${body}`;
}

function unwrapJsonish(raw: string) {
  if (!raw) return "";
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const trimmed = raw.trim();
  if (/^json\s*[\[{]/i.test(trimmed)) {
    return trimmed.replace(/^json\s*/i, "");
  }
  return trimmed;
}

function sliceBalanced(raw: string, open: string, close: string) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) {
      if (start === -1) start = i;
      depth += 1;
    } else if (ch === close && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractJSONObject(raw: string) {
  const cleaned = unwrapJsonish(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  const balanced = sliceBalanced(cleaned, "{", "}");
  if (balanced) {
    try {
      const parsed = JSON.parse(balanced);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function extractJSONArray(raw: string) {
  const cleaned = unwrapJsonish(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* ignore */
  }
  const balanced = sliceBalanced(cleaned, "[", "]");
  if (balanced) {
    try {
      const parsed = JSON.parse(balanced);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function extractObjectList(raw: string) {
  const cleaned = unwrapJsonish(raw);
  const out: any[] = [];
  let idx = 0;
  while (idx < cleaned.length) {
    const slice = cleaned.slice(idx);
    const balanced = sliceBalanced(slice, "{", "}");
    if (!balanced) break;
    idx += slice.indexOf(balanced) + balanced.length;
    try {
      const parsed = JSON.parse(balanced);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed);
      }
    } catch {
      /* ignore */
    }
  }
  return out.length ? out : null;
}

function extractRawObjectEntries(raw: string) {
  const cleaned = unwrapJsonish(raw);
  const out: string[] = [];
  let idx = 0;
  while (idx < cleaned.length) {
    const slice = cleaned.slice(idx);
    const balanced = sliceBalanced(slice, "{", "}");
    if (!balanced) break;
    idx += slice.indexOf(balanced) + balanced.length;
    out.push(balanced.trim());
  }
  if (out.length) return out;
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : null;
}

function parseLooseObject(rawObj: string, fallbackId: string) {
  const trimmed = (rawObj || "").trim();
  if (!trimmed) return null;
  const idMatch = trimmed.match(/"id"\s*:\s*"([^"]*)"/i);
  const id = (idMatch?.[1] || fallbackId || "").trim();
  const textFieldMatch = trimmed.match(/"(output_text|output|text|completion)"\s*:/i);
  if (!textFieldMatch || textFieldMatch.index == null) return null;
  const start = textFieldMatch.index + textFieldMatch[0].length;
  const end = trimmed.lastIndexOf("}");
  const slice = end > start ? trimmed.slice(start, end) : trimmed.slice(start);
  let value = slice.trim();
  value = value.replace(/,\s*$/, "");
  if (value.startsWith('"')) value = value.slice(1);
  value = value.replace(/"\s*$/, "");
  return { id, output_text: value, parseMode: "line_split_fallback" };
}

function normalizeParsed(entry: any, fallbackId: string) {
  const id = entry?.id ?? entry?.sampleId ?? entry?.sample_id ?? fallbackId;
  const output_text =
    entry?.output_text ?? entry?.output ?? entry?.text ?? entry?.completion ?? "";
  return { ...entry, id, output_text };
}

function extractOutputText(entry: any): string | null {
  const value = entry?.output_text ?? entry?.output ?? entry?.text ?? entry?.completion;
  return typeof value === "string" ? value : null;
}

type BatchParseEntry = { item: QueueItem; ok: boolean; parsed: any; raw: string };

type BatchParseResult =
  | { mode: "per_item"; entries: BatchParseEntry[] }
  | { mode: "batch_level"; ok: true; parsed: any; raw: string };

function buildBatchLevelParsed(raw: string, items: QueueItem[], candidate: unknown) {
  const cleaned = unwrapJsonish(raw);
  let output_text = cleaned;
  const outputCount = Array.isArray(candidate)
    ? candidate.length
    : candidate && typeof candidate === "object"
      ? 1
      : undefined;

  if (Array.isArray(candidate) && candidate.length === 1) {
    const only = candidate[0];
    if (only && typeof only === "object" && !Array.isArray(only)) {
      output_text = extractOutputText(only) ?? cleaned;
    }
  } else if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    output_text = extractOutputText(candidate) ?? cleaned;
  }

  return {
    output_text,
    parseMode: "batch_level_output",
    inputCount: items.length,
    outputCount,
    sampleIds: items.map((item) => item.sample.id || item.id)
  };
}

function coerceSingleObject(raw: string) {
  const obj = extractJSONObject(raw);
  if (obj) return obj;
  const arr = extractJSONArray(raw);
  if (
    Array.isArray(arr) &&
    arr.length === 1 &&
    arr[0] &&
    typeof arr[0] === "object" &&
    !Array.isArray(arr[0])
  ) {
    return arr[0];
  }
  return null;
}

function parseSingleResponse(raw: string, item: QueueItem) {
  const obj = coerceSingleObject(raw);
  if (!obj) {
    const fallbackEntries = extractRawObjectEntries(raw);
    if (fallbackEntries && fallbackEntries.length) {
      const fallback =
        parseLooseObject(fallbackEntries[0], item.sample.id || item.id) || {
          id: item.sample.id || item.id,
          output_text: fallbackEntries[0],
          parseMode: "line_split_fallback"
        };
      return { ok: true, parsed: normalizeParsed(fallback, item.sample.id || item.id) };
    }
    return { ok: false, parsed: { error: "parse_failed", raw } };
  }
  const normalized = normalizeParsed(obj, item.sample.id || item.id);
  const ok = typeof obj.ok === "undefined" ? true : Boolean(obj.ok);
  return { ok, parsed: normalized };
}

function parseBatchResponse(raw: string, items: QueueItem[], allowCountMismatch: boolean): BatchParseResult {
  const batchLevel = (candidate: unknown): BatchParseResult => ({
    mode: "batch_level",
    ok: true,
    raw,
    parsed: buildBatchLevelParsed(raw, items, candidate)
  });

  const payload = extractJSONArray(raw);
  if (Array.isArray(payload)) {
    if (allowCountMismatch && payload.length !== items.length) {
      return batchLevel(payload);
    }
    const byId = new Map<string, any>();
    payload.forEach((entry) => {
      const id = entry?.id ?? entry?.sampleId ?? entry?.sample_id;
      if (id != null) byId.set(String(id), entry);
    });
    let missing = false;
    const entries: BatchParseEntry[] = items.map((item, idx) => {
      const fallbackId = item.sample.id || item.id;
      const picked = byId.get(String(fallbackId)) ?? payload[idx];
      const entryRaw = picked ? JSON.stringify(picked) : raw;
      if (!picked) {
        missing = true;
        return {
          item,
          ok: false,
          parsed: { error: "missing_result_for_id", id: fallbackId, raw },
          raw
        };
      }
      const normalized = normalizeParsed(picked, fallbackId);
      return { item, ok: true, parsed: normalized, raw: entryRaw };
    });
    if (allowCountMismatch && missing) {
      return batchLevel(payload);
    }
    return { mode: "per_item", entries };
  }

  const looseObjects = extractObjectList(raw);
  if (looseObjects && looseObjects.length) {
    if (allowCountMismatch && looseObjects.length !== items.length) {
      return batchLevel(looseObjects);
    }
    const mapped = items.map((_item, idx) => looseObjects[idx] || looseObjects[0]);
    const entries: BatchParseEntry[] = mapped.map((entry, idx) => ({
      item: items[idx],
      ok: typeof entry.ok === "undefined" ? true : Boolean(entry.ok),
      parsed: normalizeParsed(entry, items[idx].sample.id || items[idx].id),
      raw: JSON.stringify(entry)
    }));
    return { mode: "per_item", entries };
  }

  const fallbackEntries = extractRawObjectEntries(raw);
  if (fallbackEntries && fallbackEntries.length) {
    if (allowCountMismatch && fallbackEntries.length !== items.length) {
      return batchLevel(fallbackEntries);
    }
    const fallbackObjects = fallbackEntries.map((entry, idx) => ({
      raw: entry,
      obj: parseLooseObject(entry, items[idx]?.sample.id || items[idx]?.id || "")
    }));
    const byId = new Map<string, (typeof fallbackObjects)[number]>();
    fallbackObjects.forEach((entry) => {
      if (entry.obj?.id) byId.set(String(entry.obj.id), entry);
    });

    let missing = false;
    const entries: BatchParseEntry[] = items.map((item, idx) => {
      const fallbackId = item.sample.id || item.id;
      const picked = byId.get(String(fallbackId)) ?? fallbackObjects[idx];
      if (!picked) {
        missing = true;
        return { item, ok: false, parsed: { error: "line_split_missing_entry", raw }, raw };
      }
      const parsedEntry =
        picked.obj ??
        ({
          id: fallbackId,
          output_text: picked.raw,
          parseMode: "line_split_fallback"
        } as any);
      return {
        item,
        ok: true,
        parsed: normalizeParsed(parsedEntry, fallbackId),
        raw: picked.raw
      };
    });

    if (allowCountMismatch && missing) {
      return batchLevel(fallbackEntries);
    }

    return { mode: "per_item", entries };
  }

  if (allowCountMismatch) {
    return batchLevel(null);
  }
  return {
    mode: "per_item",
    entries: items.map((item) => ({ item, ok: false, parsed: { error: "batch_parse_failed", raw }, raw }))
  };
}

async function markResult(
  item: QueueItem,
  rawResponse: string,
  parsed: any,
  ok: boolean,
  actualTarget: TargetSite
) {
  const error =
    !ok && parsed ? parsed.error || parsed.message || "parse_error" : null;
  await db.results.put({
    id: item.id,
    sampleId: item.sample.id || item.id,
    rawResponse,
    parsed,
    ok,
    error,
    target: actualTarget,
    createdAt: Date.now()
  });
  await db.queue.update(item.id, {
    status: ok ? "done" : "error",
    lastError: error,
    updatedAt: Date.now()
  });
}

async function markBatchResult(
  items: QueueItem[],
  rawResponse: string,
  parsed: any,
  actualTarget: TargetSite
) {
  const createdAt = Date.now();
  let batchId = `batch-${createdAt}-${Math.random()}`;
  try {
    batchId = `batch-${crypto.randomUUID()}`;
  } catch {
    /* ignore */
  }
  await db.results.put({
    id: batchId,
    sampleId: batchId,
    rawResponse,
    parsed,
    ok: true,
    error: null,
    target: actualTarget,
    createdAt
  });
  await Promise.all(
    items.map((item) =>
      db.queue.update(item.id, {
        status: "done",
        lastError: null,
        updatedAt: createdAt
      })
    )
  );
}

async function loadPromptFromDB(): Promise<string> {
  const doc = await db.prompts.get("active");
  return normalizePromptInput(doc?.prompt ?? DEFAULT_PROMPT);
}

async function reconcileInflightItems() {
  const inflight = await db.queue.where("status").equals("inflight").toArray();
  if (!inflight.length) return;
  const now = Date.now();
  for (const item of inflight) {
    const existingResult = await db.results.get(item.id);
    if (existingResult) {
      await db.queue.update(item.id, {
        status: existingResult.ok ? "done" : "error",
        lastError: existingResult.error ?? null,
        updatedAt: now
      });
    } else {
      await db.queue.update(item.id, {
        status: "pending",
        lastError: "recovered_after_pause_or_restart",
        retries: (item.retries || 0) + 1,
        updatedAt: now
      });
    }
  }
}

async function processOne(): Promise<boolean> {
  const batchSize = Math.max(1, state.settings.batchSize || 1);
  const items = await db.queue
    .where("[status+seq]")
    .between(["pending", Dexie.minKey], ["pending", Dexie.maxKey])
    .limit(batchSize)
    .toArray();
  if (!items.length) return false;

  const detected = await ensureTargetTab();
  if (!detected) {
    console.warn("[llm-labeler][bg] no target tab found");
    for (const item of items) {
      await db.queue.update(item.id, {
        lastError: "target_tab_not_found",
        updatedAt: Date.now()
      });
    }
    return false;
  }

  const { tabId, target } = detected;
  console.debug(
    "[llm-labeler][bg] processing batch",
    items.map((i) => i.id).join(","),
    "target",
    target
  );

  await ensureContentScript(tabId, target);

  await Promise.all(
    items.map((item) =>
      db.queue.update(item.id, {
        status: "inflight",
        target: target as AutoTarget,
        updatedAt: Date.now()
      })
    )
  );

  const prompt = buildBatchPrompt(items, state.prompt);
  const res = await sendPromptToTab(tabId, prompt, items.map((i) => i.id).join(","));
  if (!res.ok || !res.reply) {
    console.warn("[llm-labeler][bg] send failed", res.error);
    for (const item of items) {
      await db.queue.update(item.id, {
        status: "error",
        lastError: res.error || "send_failed",
        retries: (item.retries || 0) + 1,
        updatedAt: Date.now()
      });
    }
    return true;
  }

  if (items.length === 1) {
    const item = items[0];
    const parsedResult = parseSingleResponse(res.reply, item);
    await markResult(item, res.reply, parsedResult.parsed, parsedResult.ok, target);
    if (!parsedResult.ok) {
      console.warn("[llm-labeler][bg] parse error", parsedResult.parsed);
    }
    console.debug("[llm-labeler][bg] done", item.id, "ok:", parsedResult.ok);
  } else {
    const allowCountMismatch = state.settings.outputCountMode === "allow_mismatch";
    const parsed = parseBatchResponse(res.reply, items, allowCountMismatch);
    if (parsed.mode === "batch_level") {
      await markBatchResult(items, parsed.raw, parsed.parsed, target);
      console.debug(
        "[llm-labeler][bg] done batch as batch-level result",
        items.length,
        "target",
        target
      );
    } else {
      for (const entry of parsed.entries) {
        await markResult(entry.item, entry.raw, entry.parsed, entry.ok, target);
        if (!entry.ok) {
          console.warn("[llm-labeler][bg] batch parse error", entry.parsed);
        }
      }
      console.debug("[llm-labeler][bg] done batch", items.length);
    }
  }
  return true;
}

async function processBatch() {
  if (!state.running || state.processing) return;
  state.processing = true;
  try {
    const ok = await processOne();
    if (ok && state.running) {
      state.timer = setTimeout(() => {
        processBatch();
      }, state.settings.responseDelayMs);
    } else if (!ok) {
      state.running = false;
      lockedTarget = null;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
  } catch (err) {
    console.error("dispatch error", err);
  } finally {
    state.processing = false;
  }
}

function startLoop() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  processBatch();
}

async function handleStart(settings: SettingsDoc) {
  await reconcileInflightItems();
  state.settings = { ...settings, id: "active", updatedAt: Date.now() };
  await db.settings.put(state.settings);
  state.prompt = await loadPromptFromDB();
  state.running = true;
  startLoop();
}

function handlePause() {
  state.running = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  lockedTarget = null;
}

async function handleStats(): Promise<StatsSnapshot> {
  const pending = await db.queue.where("status").equals("pending").count();
  const inflight = await db.queue.where("status").equals("inflight").count();
  const done = await db.queue.where("status").equals("done").count();
  const error = await db.queue.where("status").equals("error").count();
  return { pending, inflight, done, error, running: state.running };
}

chrome.runtime.onMessage.addListener(
  (msg: BackgroundMessage, _sender, sendResponse: (res: BackgroundResponse) => void) => {
    (async () => {
      try {
        switch (msg.type) {
          case "control:start":
            await handleStart({
              ...DEFAULT_SETTINGS,
              ...msg.settings,
              id: "active",
              updatedAt: Date.now()
            });
            sendResponse({ ok: true, type: "control:start" });
            break;
          case "control:pause":
            handlePause();
            sendResponse({ ok: true, type: "control:pause" });
            break;
          case "prompt:update":
            state.prompt = normalizePromptInput(msg.prompt);
            await db.prompts.put({
              id: "active",
              prompt: state.prompt,
              updatedAt: Date.now()
            });
            sendResponse({ ok: true, type: "prompt:update" });
            break;
          case "stats:request": {
            const stats = await handleStats();
            sendResponse({ ok: true, type: "stats:request", stats });
            break;
          }
          case "queue:flush":
            processBatch();
            sendResponse({ ok: true, type: "control:start" });
            break;
          case "detect:target": {
            const detected = await detectTargetTab();
            if (detected) {
              sendResponse({
                ok: true,
                type: "stats:request",
                stats: { pending: 0, inflight: 0, done: 0, error: 0 },
                target: detected.target
              } as any);
            } else {
              sendResponse({ ok: false, error: "target_not_found" });
            }
            break;
          }
          default:
            sendResponse({ ok: false, error: "unknown_message" });
        }
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
);

// Load last settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await db.settings.get("active");
  state.settings = existing ? { ...DEFAULT_SETTINGS, ...existing } : DEFAULT_SETTINGS;
  state.prompt = await loadPromptFromDB();
  await reconcileInflightItems();
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {
        /* ignore */
      });
  }
});

// Enable side panel on target sites so the UI can sit beside Gemini/ChatGPT.
function enableSidePanel(tabId: number) {
  if (!chrome.sidePanel?.setOptions) return;
  chrome.sidePanel
    .setOptions({ tabId, path: "options.html", enabled: true })
    .catch(() => {
      /* ignore */
    });
}

function maybeEnableSidePanel(tab: chrome.tabs.Tab) {
  if (!tab.id || !tab.url) return;
  const targets = ["https://gemini.google.com/", "https://chatgpt.com/"];
  if (targets.some((u) => tab.url?.startsWith(u))) {
    enableSidePanel(tab.id);
  }
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    maybeEnableSidePanel(tab);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  maybeEnableSidePanel(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  if (lockedTarget?.tabId === tabId) {
    lockedTarget = null;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  enableSidePanel(tab.id);
  if (chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch {
      /* ignore */
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const existing = await db.settings.get("active");
  state.settings = existing ? { ...DEFAULT_SETTINGS, ...existing } : DEFAULT_SETTINGS;
  state.prompt = await loadPromptFromDB();
  await reconcileInflightItems();
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {
        /* ignore */
      });
  }
});
