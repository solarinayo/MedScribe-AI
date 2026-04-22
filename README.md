# MedScribe AI

Healthcare consultation assistant: structured visit notes in, streaming Markdown out (summary, doctor next steps, patient-friendly email draft). Authentication and subscription gating use [Clerk](https://clerk.com). LLM calls use OpenAI via a FastAPI backend.

**Deployed on Google Cloud Run** (containerized Next.js static export + FastAPI in one image).

## Architecture

- **Frontend**: Next.js (Pages Router), static export, Tailwind, `react-datepicker`, streaming via `@microsoft/fetch-event-source`.
- **Backend**: FastAPI, `POST /api/consultation` (Clerk JWT + SSE), `GET /health`, static hosting of the exported site from the same origin.
- **Production**: Single Docker image; Cloud Run invokes the container on HTTPS.

## Local development

### Frontend only (UI against a separately running API)

From `frontend/`:

```bash
cp .env.local.example .env.local
# fill Clerk keys; for API calls during dev you can run the backend on :8000
# and use a dev proxy, or test via Docker.
npm install
npm run dev
```

### Full stack in Docker (matches Cloud Run)

From the repo root (requires Docker; set env vars from `.env.example`):

```bash
export $(grep -v '^#' .env.example | xargs)  # or export your real secrets from .env

docker build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" \
  -t medscribe-ai .

docker run --rm -p 8000:8000 \
  -e CLERK_JWKS_URL="$CLERK_JWKS_URL" \
  -e CLERK_SECRET_KEY="$CLERK_SECRET_KEY" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  medscribe-ai
```

Open `http://localhost:8000`.

## Clerk setup

1. Create a Clerk application and copy the publishable key, secret key, and JWKS URL into your environment.
2. **Subscriptions**: The product page uses `<Protect plan="premium_subscription" />`. Create a plan with that identifier in Clerk (or change the `plan` prop to match your Clerk billing configuration).

## Deploy to Google Cloud Run

Prerequisites: GCP project with billing enabled, `gcloud` CLI authenticated (`gcloud auth login`), APIs enabled: **Cloud Run**, **Artifact Registry**, **Cloud Build** (optional but recommended).

### 1. Configure project and region

```bash
gcloud config set project YOUR_PROJECT_ID
export GCP_REGION=europe-west1   # or us-central1, etc.
```

### 2. Create an Artifact Registry repository (once per project/region)

```bash
gcloud artifacts repositories create medscribe-repo \
  --repository-format=docker \
  --location=$GCP_REGION
```

### 3. Build and push the image

Apple Silicon: add `--platform linux/amd64` for widest Cloud Run compatibility.

```bash
export IMAGE="$GCP_REGION-docker.pkg.dev/YOUR_PROJECT_ID/medscribe-repo/medscribe-ai"

docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" \
  -t medscribe-ai .

docker tag medscribe-ai "$IMAGE"

gcloud auth configure-docker "$GCP_REGION-docker.pkg.dev"

docker push "$IMAGE"
```

### 4. Deploy to Cloud Run

```bash
gcloud run deploy medscribe-ai \
  --image "$IMAGE" \
  --platform managed \
  --region "$GCP_REGION" \
  --allow-unauthenticated \
  --port 8000 \
  --memory 512Mi \
  --set-secrets "CLERK_SECRET_KEY=clerk-secret:latest,OPENAI_API_KEY=openai-key:latest" \
  --set-env-vars "CLERK_JWKS_URL=https://..."
```

Prefer **Secret Manager** for `CLERK_SECRET_KEY` and `OPENAI_API_KEY` instead of plain env vars in the console. For a quick class demo you can use **Edit service → Variables & secrets** in the Cloud Run UI and paste values (rotate keys after the course).

After deploy, Cloud Run prints a URL like `https://medscribe-ai-xxxxx-ew.a.run.app`. Add that URL under Clerk **Allowed redirect / authorized origins** so sign-in works in production.

### One-shot build on GCP (optional)

```bash
gcloud builds submit --tag "$IMAGE" \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
```

(Pass substitutions / cloudbuild.yaml if you need more control; see `.github/workflows/deploy-cloud-run.yml` for a CI pattern.)

## Compliance note

This repository is a **learning / demonstration** stack. Real clinical use requires appropriate regulatory, security, and privacy controls (for example HIPAA-aligned BAA, data handling, audit logging, and retention policies).

## Repository name

Keep the public repo name **`medscribe-ai`** for Andela submissions unless your cohort specifies otherwise.
