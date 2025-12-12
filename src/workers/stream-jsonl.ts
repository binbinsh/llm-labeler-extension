/// <reference lib="webworker" />
import { Inflate } from "pako";

interface RequestMessage {
  file: File;
  isGzip: boolean;
}

self.onmessage = async (ev: MessageEvent<RequestMessage>) => {
  const { file, isGzip } = ev.data;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const processChunk = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      (self as unknown as Worker).postMessage({ type: "line", line });
    }
  };

  const flushRemainder = () => {
    buffer += decoder.decode();
    if (buffer.trim()) {
      (self as unknown as Worker).postMessage({ type: "line", line: buffer });
    }
    buffer = "";
  };

  try {
    if (isGzip && typeof DecompressionStream === "undefined") {
      const reader = file.stream().getReader();
      const inflater = new Inflate({ windowBits: 15 + 32 });
      inflater.onData = (chunk: Uint8Array) => processChunk(chunk);

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        inflater.push(value, false);
        if (inflater.err) {
          throw new Error(inflater.msg || "Failed to decompress gzip stream");
        }
      }

      inflater.push(new Uint8Array(0), true);
      if (inflater.err) {
        throw new Error(inflater.msg || "Failed to decompress gzip stream");
      }
    } else {
      const stream = isGzip
        ? file.stream().pipeThrough(new DecompressionStream("gzip"))
        : file.stream();
      const reader = stream.getReader();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        processChunk(value);
      }
    }

    flushRemainder();
    (self as unknown as Worker).postMessage({ type: "done" });
  } catch (err: any) {
    (self as unknown as Worker).postMessage({
      type: "error",
      error: err?.message || err?.toString?.() || String(err)
    });
    flushRemainder();
    (self as unknown as Worker).postMessage({ type: "done" });
  }
};
