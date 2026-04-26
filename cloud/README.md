# Voiceido cloud microservice

Stateless Express server that exposes two endpoints to the **Full Page
Voiceido** Chrome extension:

| Method | Path           | Auth        | Body                                              | Returns         |
| ------ | -------------- | ----------- | ------------------------------------------------- | --------------- |
| GET    | `/health`      | none        | —                                                 | `{status, ...}` |
| POST   | `/api/ocr`     | `X-API-Key` | multipart `file` (+ optional `preserveLayout=true`) | `{text}`        |
| POST   | `/api/analyze` | `X-API-Key` | multipart `file`                                  | `{analysis}`    |

Designed to run on **Google Cloud Run** so it scales to zero (≈ $0/month
when idle) and is reachable from a browser extension over HTTPS.

## Deploy

```bash
./deploy.sh
```

The script is fully idempotent — re-run after changing code and it will
rebuild + redeploy in ~90 s. See the parent `README.md` for first-run
setup details (it bootstraps Artifact Registry, secrets, IAM, and the
Cloud Run service from a clean project).

## Run locally

```bash
npm install
API_KEY=local-test-key \
OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json \
npm run dev
```

Then `curl localhost:8080/health`.

## Environment variables

| Var                  | Required | Default                  | Notes                                                  |
| -------------------- | -------- | ------------------------ | ------------------------------------------------------ |
| `PORT`               | no       | `8080`                   | Cloud Run sets this automatically.                     |
| `API_KEY`            | yes      | —                        | Shared secret expected in `X-API-Key`.                 |
| `OPENROUTER_API_KEY` | yes for `/api/analyze` | — | Bearer token for OpenRouter.                |
| `OPENROUTER_MODEL`   | no       | `openai/gpt-4o-mini`     | Any OpenRouter multimodal model.                       |
| `MAX_FILE_BYTES`     | no       | `31457280` (30 MB)       | Per-request upload cap.                                |
| `GOOGLE_APPLICATION_CREDENTIALS` | only when running locally | — | On Cloud Run, ADC comes from the runtime service account. |

## Implementation notes

- **Auth**: constant-time `X-API-Key` compare. Returns `503` (not `401`)
  when `API_KEY` env var is missing so misconfigurations are obvious.
- **CORS**: reflects request origin (`origin: true`) — required for the
  opaque `chrome-extension://<id>` origin used by the preview page.
- **Vision**: lazy-init singleton client; pays auth cost on first request,
  not at boot, so cold starts stay quick.
- **Analyze**: runs OCR first (best-effort, errors swallowed), feeds the
  text + base64 image into a multimodal OpenRouter call with a strict
  documentation prompt that returns 6 fixed sections.
- **Storage**: `multer.memoryStorage()` — Cloud Run's filesystem is
  ephemeral and slow; in-memory keeps it simple and fast.
