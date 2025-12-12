# LLM Labeler Chrome Extension

[![Status: Research Use](https://img.shields.io/badge/status-research--only-orange)](#)
[![Chrome Extension](https://img.shields.io/badge/chrome%20extension-ready-4285F4?logo=google-chrome&logoColor=white)](#)
[![Manifest v3](https://img.shields.io/badge/manifest-v3-orange)](#)

Chrome extension to batch labeling with Gemini / ChatGPT web. Data is stored locally in IndexedDB so prompts, imports, and results stay on your machine.

<p align="center">
 <img src="https://raw.githubusercontent.com/binbinsh/llm-labeler-extension/main/screenshot.png" alt="Side panel workflow" width="800">
</p>

## Quick start
### Option A
Download the latest ZIP from Releases, unzip, then load the folder as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).

### Option B
Build locally with `npm install`, `npm run build`, and load `dist/` in Google Chrome as an unpacked extension.

## Using the UI
- Set your prompt, batch size, and delay, then Save.
- Import `jsonl` / `jsonl.gz` (one JSON object per line); preview shows the latest 20 results.
- With a signed-in Gemini or ChatGPT tab open, click Start.
- Pause stops, Retry requeues errors, Export downloads JSONL.
- The first batch sends the prompt plus samples; later batches send only samples.

## Disclaimer
This extension is for research and educational purposes only. Users are responsible for complying with the terms of service of Gemini, ChatGPT, and any other platforms used. The authors assume no liability for misuse or violations of third-party policies.
