# LLM Labeler Extension

[![Chrome Extension](https://img.shields.io/badge/chrome%20extension-ready-4285F4?logo=google-chrome&logoColor=white)](#)
[![Manifest v3](https://img.shields.io/badge/manifest-v3-orange)](#)
[![Status: Research Use](https://img.shields.io/badge/status-research--only-orange)](#)

Chrome extension to batch labeling with Gemini / ChatGPT web. The first batch sends your instruction prompt plus the samples; later batches send only the samples (the model should keep replying with a JSON array of `{ "id": ..., "output_text": ... }`).

<p align="center">
  <img src="https://raw.githubusercontent.com/binbinsh/llm-labeler-extension/main/screenshot.png" alt="Side panel workflow" width="800">
</p>

## Quick start
1. `npm install`
2. `npm run build`
3. Load `dist/` as an unpacked extension in Chrome and open the side-panel (Options).

## Using the UI
- Paste or adjust the prompt (default: SSML-style emoji narrator), set batch size and delay, then save.
- Import `jsonl` / `jsonl.gz` files; each non-empty line is kept raw (e.g. `{ "id": "...", "input_text": "..." }`). Batches are newline-joined.
- Click Start while a Gemini or ChatGPT tab is open and logged in; use Pause to stop. Retry errors requeues failed items; Export results downloads JSONL. A preview shows the latest 20 stored results.

## Disclaimer
This extension is for research and educational purposes only. Users are responsible for complying with the terms of service of Gemini, ChatGPT, and any other platforms used. The authors assume no liability for misuse or violations of third-party policies.
