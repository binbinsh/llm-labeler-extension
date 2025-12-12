const INPUT_SELECTORS = [
  // New Gemini rich editor
  '.ql-editor.textarea[contenteditable="true"]',
  '.ql-editor[contenteditable="true"]',
  '[data-node-type="input-area"] .ql-editor',
  '[data-node-type="input-area"] [contenteditable="true"]',
  "[data-textinput]",
  '[role="textbox"][contenteditable="true"]',
  'div[role="textbox"]',
  'div[contenteditable="true"]',
  "textarea",
  "textarea[aria-label]"
];

const REPLY_SELECTORS = [
  "[data-md]",
  "[data-message-author-role='assistant']",
  "[data-message-author-role='model']",
  "article",
  "[aria-live='polite']",
  '[role="article"]'
];

const STOP_SELECTORS = [
  'button[aria-label*="Stop"]',
  'button[aria-label*="停止"]',
  'button[data-testid*="stop"]',
  'button[data-id*="stop"]'
];

function findInput(): HTMLElement | null {
  for (const sel of INPUT_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

function escapeHtml(text: string) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function setInputValue(el: HTMLElement, value: string): boolean {
  const isRich = el.classList.contains("ql-editor") || el.closest(".ql-editor");
  if (isRich) {
    const target = el.classList.contains("ql-editor") ? el : (el.closest(".ql-editor") as HTMLElement);
    if (target) {
      target.innerHTML = `<p>${escapeHtml(value)}</p>`;
      target.focus();
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" })
      );
    } else {
      return false;
    }
  } else if ("value" in el) {
    (el as HTMLTextAreaElement).value = value;
    (el as HTMLTextAreaElement).focus();
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" })
    );
  } else {
    el.textContent = value;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" })
    );
    el.focus();
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
}

function clickSend() {
  const selectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send message"]',
    'button[type="submit"]',
    'button[data-testid*="send"]',
    'button[data-id*="send"]',
    '.send-button',
    'button.send-button',
    '.send-button-container .send-button',
    'button.submit',
    '.send-button-container button',
    '.mat-mdc-icon-button.send-button',
    'button[mat-icon-button][aria-label*="send"]',
    'button[mat-icon-button][aria-label*="发送"]'
  ];
  for (const sel of selectors) {
    const btn = document.querySelector(sel) as HTMLButtonElement | null;
    if (btn) {
      // Some buttons start disabled until input event fires
      (btn as any).disabled = false;
      btn.removeAttribute?.("aria-disabled");
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      btn.click();
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      console.debug("[llm-labeler][gemini] clicked send via selector", sel);
      return true;
    }
  }
  console.warn("[llm-labeler][gemini] send button not found with selectors");
  return false;
}

async function clickSendWithRetry(attempts = 5, delayMs = 80): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const ok = clickSend();
    if (ok) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.warn("[llm-labeler][gemini] no send button matched after retry");
  return false;
}

function readReplies(): string[] {
  for (const sel of REPLY_SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length) {
      return Array.from(nodes)
        .map((n) => n.textContent || "")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function isGenerating() {
  return Boolean(document.querySelector(STOP_SELECTORS.join(",")));
}

async function waitForReply(timeoutMs = 60000, settleMs = 900): Promise<string> {
  let lastList = readReplies();
  let lastText = lastList.length ? lastList[lastList.length - 1] : "";
  return new Promise((resolve, reject) => {
    let settleTimer: number | undefined;
    const finishIfSettled = () => {
      const currentList = readReplies();
      const latest = currentList.length ? currentList[currentList.length - 1] : lastText;
      if (latest && !isGenerating() && latest === lastText) {
        cleanup();
        resolve(latest);
      }
    };
    const scheduleSettle = () => {
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(finishIfSettled, settleMs);
    };
    const observer = new MutationObserver(() => {
      const currentList = readReplies();
      if (currentList.length) {
        lastList = currentList;
        lastText = currentList[currentList.length - 1];
        scheduleSettle();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleSettle();

    const timeoutId = window.setTimeout(() => {
      cleanup();
      const currentList = readReplies();
      const latest = currentList.length ? currentList[currentList.length - 1] : lastText;
      if (latest) {
        resolve(latest);
      } else {
        reject(new Error("timeout"));
      }
    }, timeoutMs);

    const cleanup = () => {
      observer.disconnect();
      if (settleTimer) window.clearTimeout(settleTimer);
      window.clearTimeout(timeoutId);
    };
  });
}

async function handlePrompt(prompt: string) {
  const input = findInput();
  if (!input) throw new Error("input_not_found");
  console.debug("[llm-labeler][gemini] setting prompt");
  const okSet = setInputValue(input, prompt);
  if (!okSet) {
    throw new Error("set_input_failed");
  }
  // allow UI to enable the send button
  await new Promise((r) => setTimeout(r, 80));
  const sent = await clickSendWithRetry();
  console.debug("[llm-labeler][gemini] click send =>", sent);
  // Always fire an Enter sequence as a backup (Gemini sometimes ignores click)
  const events = ["keydown", "keypress", "keyup"] as const;
  for (const type of events) {
    input.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true })
    );
  }
  if (!sent) {
    console.warn("[llm-labeler][gemini] send button not clicked, dispatched Enter fallback");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true })
    );
  }
  const reply = await waitForReply();
  console.debug("[llm-labeler][gemini] reply captured", reply?.slice(0, 120));
  return reply;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "ping") {
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "run_prompt") {
      try {
        const reply = await handlePrompt(msg.prompt);
        sendResponse({ ok: true, reply, sampleId: msg.sampleId });
      } catch (error: any) {
        sendResponse({ ok: false, error: String(error) });
      }
    }
  })();
  return true;
});

export {};

console.debug("[llm-labeler][gemini] content script loaded");
