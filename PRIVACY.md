# Privacy Policy — Full Page Voiceido

_Last updated: 2026-04-26_

Full Page Voiceido ("the extension") is a Chrome browser extension published by
**aliyevdevops** that captures the visible web page in the active tab as a
screenshot.

This document describes what data the extension handles, where it goes, and
how long it is kept.

---

## 1. What the extension does

The core feature — capturing the active tab as a PNG/PDF — runs **entirely on
your device**. No screenshots, URLs, or page contents are sent anywhere by
default.

Two optional features (`OCR · txt` and `Analyze · txt`) send the captured
image to a self-hosted backend service that the user must configure with a
URL and an API key in the extension settings. If the user does not provide
these credentials, the optional features stay disabled and no network
requests are made.

---

## 2. Data collected and why

| Data                             | Purpose                                                                 | Sent off-device?                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Screenshot of the active tab     | Render the preview, allow PNG / PDF download                            | No — stays in the browser.                                                                        |
| Screenshot of the active tab     | Run OCR or AI image analysis (optional)                                 | Yes — only if the user has configured a backend URL + API key and explicitly clicks `OCR` / `Analyze`. The image is `POST`ed once to that backend over HTTPS. |
| User preferences (capture mode, expand-scrollables, backend URL, API key) | Persist user settings between sessions   | No — stored in `chrome.storage.local` on the user's device.                                       |
| Browsing history / page URLs     | Not used.                                                               | No.                                                                                               |
| Personally identifiable info     | Not collected.                                                          | No.                                                                                               |
| Authentication credentials       | Not collected.                                                          | No.                                                                                               |
| Health, financial, or location data | Not collected.                                                       | No.                                                                                               |

The extension does **not** use analytics, telemetry, advertising SDKs, or
any third-party trackers.

---

## 3. Where data goes when OCR / Analyze is used

When (and only when) the user clicks `OCR · txt` or `Analyze · txt`:

1. The captured screenshot is converted to JPEG in the user's browser.
2. The JPEG is `POST`ed over HTTPS to the backend URL the user configured.
   The reference deployment is a Google Cloud Run service operated by the
   developer, but any user may self-host the backend (the source code is on
   GitHub) and point the extension at their own deployment.
3. The backend forwards the image to one of:
   - **Google Cloud Vision API** (for OCR) — see Google's
     [Cloud Vision data usage statement](https://cloud.google.com/vision/docs/data-usage).
   - **OpenRouter / OpenAI GPT-4o-mini** (for Analyze) — see
     [OpenRouter's privacy policy](https://openrouter.ai/privacy).
4. The backend returns the recognised text or analysis text to the
   extension. The image is not retained server-side beyond the request.

These third parties are necessary to provide the OCR / Analyze feature and
are not used for any other purpose.

---

## 4. Limited Use disclosure

> The use of information received from Google APIs will adhere to the
> [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/),
> including the Limited Use requirements.

We use the data described above **only** to provide the extension's stated
features (full-page capture, OCR, AI analysis). We do not transfer this data
to third parties for advertising, profiling, credit-worthiness, or any
purpose other than running the user-requested feature, and we do not allow
humans to read it.

---

## 5. Data retention

- Screenshots are held in browser memory for the duration of the preview
  tab. Closing the tab discards them.
- User preferences live in `chrome.storage.local` until the extension is
  uninstalled or the user clears them.
- No server-side persistence is performed by the reference backend.

---

## 6. Permissions used

| Permission     | Why it is requested                                             |
| -------------- | --------------------------------------------------------------- |
| `activeTab`    | Capture the currently focused tab when the user clicks the toolbar button. |
| `scripting`    | Inject a measurement / scroll script to take a full-page screenshot. |
| `storage`      | Save user preferences (capture mode, backend URL, API key).      |
| `downloads`    | Save the captured PNG, PDF, or OCR text to the user's disk.     |
| `offscreen`    | Stitch large screenshots in an offscreen canvas without freezing the tab. |

`host_permissions` is empty — the extension never reads or modifies any
website's data automatically. It only acts on the active tab when the user
clicks the toolbar button.

---

## 7. Children

The extension is not directed to children under 13 and does not knowingly
collect data from them.

---

## 8. Contact

Questions or requests:
**aliyevdevops@gmail.com**

Source code: <https://github.com/aliyevom/voiceido-chrome>
