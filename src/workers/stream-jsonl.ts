/// <reference lib="webworker" />
import { ungzip } from "pako";

interface RequestMessage {
  file: File;
  isGzip: boolean;
}

self.onmessage = async (ev: MessageEvent<RequestMessage>) => {
  const { file, isGzip } = ev.data;
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  const chunkSize = 1024 * 512;
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let data: Uint8Array = value!;
    if (isGzip) {
      data = ungzip(data);
    }
    buffer += decoder.decode(data, { stream: true });
    let lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      (self as unknown as Worker).postMessage({ type: "line", line });
    }
  }

  if (buffer.trim()) {
    (self as unknown as Worker).postMessage({ type: "line", line: buffer });
  }

  (self as unknown as Worker).postMessage({ type: "done" });
};
