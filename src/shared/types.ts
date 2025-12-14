export type TargetSite = "gemini" | "chatgpt";
export type AutoTarget = TargetSite | "auto";

export type QueueStatus = "pending" | "inflight" | "done" | "error";

export interface Sample {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QueueItem {
  id: string;
  // Stable import order (used for deterministic dispatch ordering).
  seq: number;
  prompt: string;
  sample: Sample;
  status: QueueStatus;
  target: AutoTarget;
  retries: number;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResultRecord {
  id: string;
  sampleId: string;
  rawResponse: string;
  parsed?: unknown;
  ok: boolean;
  error?: string | null;
  target: TargetSite;
  createdAt: number;
}

export interface PromptDoc {
  id: string;
  prompt: string;
  updatedAt: number;
}

export interface SettingsDoc {
  id: string;
  // How long to wait after assistant finishes before sending next message (ms)
  responseDelayMs: number;
  // How many samples to send per prompt
  batchSize: number;
  // Which top-level JSON keys to extract into input_text on import.
  inputKeys: string[];
  // Percentage of imported samples to enqueue (1-100).
  // 100 preserves original file order; lower values randomly sample that share of lines.
  samplePercent: number;
  // Whether to enforce output count == input batch size
  outputCountMode: OutputCountMode;
  updatedAt: number;
}

export type OutputCountMode = "match_input" | "allow_mismatch";

export interface StatsSnapshot {
  pending: number;
  inflight: number;
  done: number;
  error: number;
  running?: boolean;
}

export type BackgroundMessage =
  | { type: "control:start"; settings: Omit<SettingsDoc, "id" | "updatedAt"> }
  | { type: "control:pause" }
  | { type: "prompt:update"; prompt: string }
  | { type: "stats:request" }
  | { type: "queue:flush" } // notify background new data arrived
  | { type: "detect:target" };

export type BackgroundResponse =
  | { ok: true; type: "control:start" | "control:pause" | "prompt:update" }
  | { ok: true; type: "stats:request"; stats: StatsSnapshot }
  | { ok: false; error: string };
