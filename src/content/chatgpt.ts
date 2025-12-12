const INPUT_SELECTORS = [
  '#prompt-textarea[contenteditable="true"]',
  '[data-testid="prompt-textarea"][contenteditable="true"]',
  '.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea:not([style*="display: none"])',
  'textarea'
];

const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop generating"]',
  'button[aria-label*="Stop"]'
];

const REPLY_SELECTORS = [
  '[data-message-author-role="assistant"]',
  'article',
  '[data-testid="assistant-message"]'
];

function isVisible(el: Element | null): el is HTMLElement {
  if (!el || !(el as HTMLElement).getBoundingClientRect) return false;
  const rect = (el as HTMLElement).getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el as HTMLElement);
  return style.display !== "none" && style.visibility !== "hidden";
}

function findInput(): HTMLTextAreaElement | HTMLDivElement | null {
  for (const sel of INPUT_SELECTORS) {
    const matches = Array.from(
      document.querySelectorAll(sel)
    ) as (HTMLTextAreaElement | HTMLDivElement)[];
    const visible = matches.find(isVisible);
    if (visible) return visible;
  }
  return null;
}

function escapeHtml(text: string) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function isProseMirror(el: Element | null): el is HTMLElement {
  if (!el) return false;
  return (
    (el instanceof HTMLElement && el.classList.contains("ProseMirror")) ||
    Boolean((el as HTMLElement).closest?.(".ProseMirror"))
  );
}

function placeCaretAtEnd(target: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function setInputValue(el: HTMLTextAreaElement | HTMLDivElement, value: string): boolean {
  const text = value ?? "";
  const isRich = isProseMirror(el);
  const target = isRich
    ? ((el.classList.contains("ProseMirror") ? el : el.closest(".ProseMirror")) as HTMLElement)
    : el;

  if (!target) return false;

  const triggerInput = (inputType: string) => {
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType
      })
    );
  };

  const clearExisting = () => {
    target.focus();
    try {
      document.execCommand("selectAll");
      document.execCommand("delete");
    } catch {
      /* ignore */
    }
  };

  const tryInsertText = () => {
    try {
      return document.execCommand("insertText", false, text);
    } catch {
      return false;
    }
  };

  const pasteText = () => {
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const evt = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true
      });
      return target.dispatchEvent(evt);
    } catch {
      return false;
    }
  };

  if (isRich) {
    clearExisting();
    target.focus();
    let inserted = tryInsertText();
    if (!inserted) {
      inserted = pasteText();
    }
    if (!inserted) {
      const paragraphs = text.split(/\n/).map((line) => {
        if (!line) return "<p><br></p>";
        return `<p>${escapeHtml(line)}</p>`;
      });
      target.innerHTML = paragraphs.join("");
    }
    placeCaretAtEnd(target);
    triggerInput("insertFromPaste");
  } else if ("value" in target) {
    (target as HTMLTextAreaElement).value = text;
    target.focus();
    triggerInput("insertText");
  } else {
    target.textContent = text;
    target.focus();
    triggerInput("insertText");
  }

  target.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function clickSend() {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="Send message"]',
    'button[type="submit"]'
  ];
  for (const sel of selectors) {
    const btn = document.querySelector(sel) as HTMLButtonElement | null;
    if (btn && isVisible(btn)) {
      (btn as any).disabled = false;
      btn.removeAttribute?.("aria-disabled");
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      btn.click();
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    }
  }
  return false;
}

async function clickSendWithRetry(attempts = 5, delayMs = 80): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const ok = clickSend();
    if (ok) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function readLatestReply(): string | null {
  for (const sel of REPLY_SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length) {
      const txt = nodes[nodes.length - 1].textContent || "";
      if (txt.trim()) return txt.trim();
    }
  }
  return null;
}

function isGenerating() {
  return Boolean(document.querySelector(STOP_SELECTORS.join(",")));
}

async function waitForReply(timeoutMs = 60000, settleMs = 900): Promise<string> {
  let last = readLatestReply() || "";
  return new Promise((resolve, reject) => {
    let settleTimer: number | undefined;
    const finishIfSettled = () => {
      const latest = readLatestReply() || last;
      if (latest && !isGenerating() && latest === last) {
        cleanup();
        resolve(latest);
      }
    };
    const scheduleSettle = () => {
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(finishIfSettled, settleMs);
    };
    const observer = new MutationObserver(() => {
      const current = readLatestReply();
      if (current) {
        last = current;
        scheduleSettle();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleSettle();

    const timeoutId = window.setTimeout(() => {
      cleanup();
      const latest = readLatestReply() || last;
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
  const okSet = setInputValue(input, prompt);
  if (!okSet) throw new Error("set_input_failed");
  await new Promise((r) => setTimeout(r, 80));
  const sent = await clickSendWithRetry();
  if (!sent) {
    const events = ["keydown", "keypress", "keyup"] as const;
    for (const type of events) {
      input.dispatchEvent(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true })
      );
    }
  }
  const reply = await waitForReply();
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
