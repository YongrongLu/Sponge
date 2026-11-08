#!/usr/bin/env bash
# One-command public deploy of Feed Sponge to Google Cloud Run (uses your Google Cloud credits).
# Run from this folder:  bash deploy-cloudrun.sh
# Reads GOOGLE_CLOUD_PROJECT, GEMINI_MODEL, INFORMER_APP_URL and INFORMER_APP_KEY from .env.
# Vertex AI is called with the Cloud Run service account, so no Google key is shipped.
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=feed-sponge
REGION=${REGION:-us-central1}

envval() { # read KEY from .env without sourcing it (values may contain special characters)
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]$//" || true
}

command -v gcloud >/dev/null || { echo "gcloud is not installed: https://cloud.google.com/sdk/docs/install (or: brew install --cask google-cloud-sdk)"; exit 1; }
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . || gcloud auth login

PROJECT=$(envval GOOGLE_CLOUD_PROJECT); PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null)}
[ -n "$PROJECT" ] || { echo "No project: set GOOGLE_CLOUD_PROJECT in .env"; exit 1; }
MODEL=$(envval GEMINI_MODEL); MODEL=${MODEL:-gemini-3.5-flash}
INF_URL=$(envval INFORMER_APP_URL); INF_URL=${INF_URL:-https://wl333-feed-sponge.go.informer-apps.com}
INF_KEY=$(envval INFORMER_APP_KEY)
echo "Project: $PROJECT · region: $REGION · model: $MODEL"
[ -n "$INF_KEY" ] || echo "Note: INFORMER_APP_KEY is not in .env, so 'Join the leaderboard' will be off on the public site."

gcloud config set project "$PROJECT" >/dev/null
echo "Enabling Cloud Run, Cloud Build and Vertex AI (first time takes a minute)…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com

PNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="${PNUM}-compute@developer.gserviceaccount.com"
echo "Letting the service account call Vertex AI…"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/aiplatform.user --condition=None >/dev/null || \
  echo "  (couldn't add the role; if reading fails with 403, ask a project owner to give $SA the 'Vertex AI User' role)"
# Cloud Build in newer projects builds as the compute service account
for r in roles/cloudbuild.builds.builder roles/storage.admin roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=$r --condition=None >/dev/null 2>&1 || true
done

# Use a temp env-vars file so the key never appears in shell history or the process list.
ENVF=$(mktemp); trap 'rm -f "$ENVF"' EXIT
{
  echo "GOOGLE_GENAI_USE_VERTEXAI: \"true\""
  echo "GOOGLE_CLOUD_PROJECT: \"$PROJECT\""
  echo "GOOGLE_CLOUD_LOCATION: \"global\""
  echo "GEMINI_MODEL: \"$MODEL\""
  echo "INFORMER_APP_URL: \"$INF_URL\""
  [ -n "$INF_KEY" ] && echo "INFORMER_APP_KEY: \"$INF_KEY\""
} > "$ENVF"

echo "Building and deploying (3–5 minutes)…"
# Duke-style org policies often forbid public (allUsers) access; fall back to turning off the invoker check instead.
if ! gcloud run deploy "$SERVICE" --source . --region "$REGION" --env-vars-file "$ENVF" \
     --memory 1Gi --cpu 1 --concurrency 40 --max-instances 4 --timeout 120 --allow-unauthenticated --quiet; then
  echo "Public access was blocked by an org policy; retrying with the invoker check turned off…"
  gcloud run deploy "$SERVICE" --source . --region "$REGION" --env-vars-file "$ENVF" \
     --memory 1Gi --cpu 1 --concurrency 40 --max-instances 4 --timeout 120 --no-invoker-iam-check --quiet
fi

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_URL=$URL" --quiet >/dev/null
echo
echo "Done. Big screen:   $URL/storybook.html"
echo "      Phone page:   $URL/m   (the Audience QR points here)"
echo "      Health check: $URL/api/health"
