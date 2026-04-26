#!/usr/bin/env bash
# ------------------------------------------------------------------
# Voiceido Cloud Run deploy — idempotent.
#
# What this script does (each step skips if already done):
#   1. Sets active gcloud project
#   2. Enables required Google APIs (Cloud Run, Artifact Registry,
#      Cloud Build, Vision, Secret Manager)
#   3. Creates an Artifact Registry repo for our Docker image
#   4. Creates two Secret Manager secrets:
#        - voiceido-api-key      (auto-generated random key for X-API-Key)
#        - voiceido-openrouter-key (you paste your OpenRouter key once)
#   5. Creates a runtime service account with:
#        - secretmanager.secretAccessor
#        - cloudvision.user
#        - logging.logWriter
#   6. Builds + pushes the container with Cloud Build
#   7. Deploys the service to Cloud Run (public, gated by API key)
#   8. Prints the service URL + how to read the API key.
#
# Re-run safely after code changes: only step 6 (Cloud Build) and step 7
# (Cloud Run deploy) take meaningful time.
# ------------------------------------------------------------------

set -euo pipefail

# --- Defaults — override via env vars before running ---------------
PROJECT_ID="${PROJECT_ID:-ocr-project-1770234385}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-voiceido-api}"
REPO_NAME="${REPO_NAME:-voiceido}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:${IMAGE_TAG}"

API_KEY_SECRET="${API_KEY_SECRET:-voiceido-api-key}"
OPENROUTER_SECRET="${OPENROUTER_SECRET:-voiceido-openrouter-key}"
RUNTIME_SA_NAME="${SERVICE_NAME}-runner"
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m▶\033[0m %s\n' "$*"; }
note() { printf '  \033[2m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }

# Ensure we run from the cloud/ folder so docker/build context is right.
cd "$(dirname "$0")"

bold "Voiceido Cloud Run deploy"
note "Project : $PROJECT_ID"
note "Region  : $REGION"
note "Service : $SERVICE_NAME"
note "Image   : $IMAGE"

# --- 0. gcloud sanity check ----------------------------------------
if ! command -v gcloud >/dev/null 2>&1; then
  echo "✗ gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi

step "Setting active gcloud project to $PROJECT_ID"
gcloud config set project "$PROJECT_ID" >/dev/null
ok "active project = $PROJECT_ID"

# --- 1. Enable APIs ------------------------------------------------
step "Enabling Google APIs (idempotent)"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  vision.googleapis.com \
  secretmanager.googleapis.com \
  --quiet
ok "APIs enabled"

# --- 2. Artifact Registry ------------------------------------------
step "Ensuring Artifact Registry repo '$REPO_NAME' in $REGION"
if ! gcloud artifacts repositories describe "$REPO_NAME" --location "$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Voiceido Cloud Run images" \
    --quiet
  ok "created repo $REPO_NAME"
else
  ok "repo $REPO_NAME already exists"
fi

# --- 3. Secrets ----------------------------------------------------
step "Ensuring API key secret '$API_KEY_SECRET'"
if ! gcloud secrets describe "$API_KEY_SECRET" >/dev/null 2>&1; then
  GENERATED_KEY=$(openssl rand -base64 36 | tr -d '=+/\n' | head -c 40)
  printf '%s' "$GENERATED_KEY" | gcloud secrets create "$API_KEY_SECRET" \
    --replication-policy=automatic \
    --data-file=- \
    --quiet
  ok "created $API_KEY_SECRET"
  note "(generated value will be printed at the end — copy it once)"
else
  ok "$API_KEY_SECRET already exists"
fi

step "Ensuring OpenRouter key secret '$OPENROUTER_SECRET'"
if ! gcloud secrets describe "$OPENROUTER_SECRET" >/dev/null 2>&1; then
  echo "  ┃ Paste your OpenRouter API key (starts with 'sk-or-v1-'),"
  echo "  ┃ then press <Return> followed by Ctrl-D:"
  gcloud secrets create "$OPENROUTER_SECRET" \
    --replication-policy=automatic \
    --data-file=- \
    --quiet
  ok "created $OPENROUTER_SECRET"
else
  ok "$OPENROUTER_SECRET already exists"
  note "(re-run \`gcloud secrets versions add $OPENROUTER_SECRET --data-file=-\` to rotate)"
fi

# --- 4. Runtime service account + IAM bindings ---------------------
step "Ensuring runtime service account '$RUNTIME_SA_EMAIL'"
if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --display-name="Voiceido Cloud Run runtime" \
    --quiet
  ok "created service account"
  # IAM creation is eventually consistent — wait until describe round-trips
  # before binding roles so add-iam-policy-binding doesn't 400 us out.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
else
  ok "service account already exists"
fi

# Roles:
#   secretmanager.secretAccessor        — read API_KEY + OPENROUTER_API_KEY at boot
#   serviceusage.serviceUsageConsumer   — use enabled APIs (Vision) under this project's quota
#   logging.logWriter                   — emit structured logs to Cloud Logging
# Note: there is *no* predefined `roles/cloudvision.*` role for textDetection /
# documentTextDetection; serviceUsageConsumer is the right scope. We omit
# `--condition` entirely because newer gcloud versions interpret
# `--condition=None` as a literal condition expression.
step "Granting roles to runtime SA"
for ROLE in \
  roles/secretmanager.secretAccessor \
  roles/serviceusage.serviceUsageConsumer \
  roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_SA_EMAIL" \
    --role="$ROLE" \
    --quiet >/dev/null
  ok "+ $ROLE"
done

# --- 5. Build container with Cloud Build ---------------------------
step "Building container image with Cloud Build"
note "image: $IMAGE"
gcloud builds submit --tag "$IMAGE" --quiet
ok "image pushed"

# --- 6. Deploy Cloud Run -------------------------------------------
step "Deploying to Cloud Run service '$SERVICE_NAME'"
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --service-account="$RUNTIME_SA_EMAIL" \
  --set-secrets="API_KEY=${API_KEY_SECRET}:latest,OPENROUTER_API_KEY=${OPENROUTER_SECRET}:latest" \
  --set-env-vars="OPENROUTER_MODEL=openai/gpt-4o-mini" \
  --memory=1Gi \
  --cpu=1 \
  --concurrency=20 \
  --timeout=300s \
  --max-instances=5 \
  --min-instances=0 \
  --quiet
ok "Cloud Run deployment complete"

# --- 7. Output ------------------------------------------------------
URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')
API_KEY=$(gcloud secrets versions access latest --secret="$API_KEY_SECRET")

echo ""
bold "Deployed."
echo "  Service URL : $URL"
echo "  Health      : $URL/health"
echo "  X-API-Key   : $API_KEY"
echo ""
bold "Hook the extension up"
echo "  1. Capture any page in the extension to open the preview tab."
echo "  2. Click the gear icon (top-right of the preview)."
echo "  3. Paste the URL + API key above and hit 'Test connection'."
echo "  4. Then 'OCR · txt' and 'Analyze · txt' buttons go live."
echo ""
note "Re-run this script after code changes — it'll skip steps 1-4 and only build + redeploy."
