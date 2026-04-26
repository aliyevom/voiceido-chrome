# Full Page Voiceido

Full Page Voiceido is a **Manifest V3 + TypeScript Chrome extension** for capturing full-page browser screenshots, previewing the result, and optionally sending the captured image to a backend service for OCR and AI-based analysis.

The project is structured as two main parts:

1. **Chrome extension frontend** — handles capture, preview, local export, and user interaction.
2. **Cloud backend** — handles OCR and AI analysis when the user requests it.

The goal of the architecture is to keep browser-side capture fast and lightweight while moving heavier text extraction and multimodal analysis into a separate backend service.

---

## What It Does

Full Page Voiceido allows a user to capture the content of the active browser tab as an image.

The extension supports:

- Full-page screenshot capture
- Optional inner-section capture for scrollable containers
- Previewing the captured result inside the extension
- Exporting the capture as PNG or PDF
- Sending the capture to a backend OCR service
- Sending the capture to an AI analysis service
- Running with minimal Chrome permissions

The core screenshot and export flow works locally inside the browser. OCR and AI analysis require the backend service.

---

## High-Level Architecture

```text
┌──────────────┐
│ Popup UI     │
│ User action  │
└──────┬───────┘
       │
       │ Start capture
       ▼
┌────────────────────┐
│ Service Worker     │
│ Capture coordinator│
└──────┬─────────────┘
       │
       │ Inject capture script
       ▼
┌────────────────────┐
│ Content Script     │
│ Page measurement   │
│ Scroll control     │
└──────┬─────────────┘
       │
       │ Capture visible tiles
       ▼
┌────────────────────┐
│ Chrome Capture API │
│ Viewport images    │
└──────┬─────────────┘
       │
       │ Image tiles
       ▼
┌────────────────────┐
│ Offscreen Document │
│ Canvas stitching   │
└──────┬─────────────┘
       │
       │ Final image bundle
       ▼
┌────────────────────┐
│ Preview Page       │
│ Export + analysis  │
└──────┬─────────────┘
       │
       ├── Save PNG locally
       ├── Generate PDF locally
       ├── Send to OCR API
       └── Send to Analyze API