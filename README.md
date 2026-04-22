# MedScribe AI

Healthcare consultation assistant: structured visit notes in, streaming Markdown out (summary, doctor next steps, patient-friendly email draft). Authentication and subscription gating use [Clerk](https://clerk.com). LLM calls go through **OpenRouter** (or direct OpenAI) from the FastAPI backend, using the OpenAI-compatible API.

**Deployed on Google Cloud Run** (containerized Next.js static export + FastAPI in one image).

## Architecture

- **Frontend**: Next.js (Pages Router), static export, Tailwind, `react-datepicker`, streaming via `@microsoft/fetch-event-source`.
- **Backend**: FastAPI, `POST /api/consultation` (Clerk JWT + SSE), `GET /health`, static hosting of the exported site from the same origin. LLM: [OpenRouter](https://openrouter.ai) (default) or direct OpenAI, via the `openai` Python package. In **`npm run dev`**, the UI calls **http://127.0.0.1:8000** for `/api/...` by default so the browser sends `Authorization` to Uvicorn (the Next dev *rewrite* proxy is prone to dropping it, which shows up as **Clerk 403 Forbidden**). Optional `X-Medscribe-Auth` is still sent and copied server-side. Production uses same-origin `/api/...` in the Docker/Cloud Run image.
- **Production**: Single Docker image; Cloud Run invokes the container on HTTPS.

## Local development

### Next.js dev + FastAPI on port 8000 (recommended for UI work)

You need **FastAPI** (port 8000) and the **Next dev** server (port 3000). The **UI calls the API on port 8000** (CORS is allowed from :3000). `next.config.ts` rewrites are **optional**; you can set `NEXT_PUBLIC_USE_DEV_PROXY=1` in `frontend/.env.local` to use the rewrite to FastAPI instead of a direct call.

**Terminal 1 — API** (from the **repo root**; needs `CLERK_JWKS_URL` and **`OPENROUTER_API_KEY`** or **`OPENAI_API_KEY`** in root `.env`):

```bash
pip install -r requirements.txt
./scripts/dev-api.sh
```

(Or run `cd backend` and `uvicorn server:app --reload --host 127.0.0.1 --port 8000` with those variables exported by hand.)

**Terminal 2 — UI** from `frontend/`:

```bash
cp .env.local.example .env.local
# add Clerk keys; no need to set NEXT_PUBLIC_API_ORIGIN unless you want to override
npm install
npm run dev
```

Open `http://localhost:3000`. Restart the dev server after any `next.config` change.

In **Docker / Cloud Run**, the static site and API share one origin, so the client still uses relative `/api/...` and rewrites are not part of the exported bundle.

### Full stack in Docker (matches Cloud Run)

From the repo root (requires Docker; set env vars from `.env.example`):

```bash
export $(grep -v '^#' .env.example | xargs)  # or export your real secrets from .env

docker build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" \
  -t medscribe-ai .

docker run --rm -p 8000:8000 \
  -e CLERK_JWKS_URL="$CLERK_JWKS_URL" \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -e OPENAI_MODEL="${OPENAI_MODEL:-openai/gpt-4o-mini}" \
  medscribe-ai
# Optional: -e CLERK_SECRET_KEY=... if you add Clerk server-side API usage (not read by the current app).
```

Open `http://localhost:8000`.

## Clerk setup

1. Create a Clerk application and copy the publishable key, secret key, and JWKS URL into your environment.
2. **Subscriptions (optional)**: By default, `/product` only requires sign-in (Clerk’s free developer tier is enough). To gate on Clerk Billing, set `NEXT_PUBLIC_CLERK_REQUIRED_PLAN` (for example `premium_subscription`) in `.env.local` before `next build`, enable Billing in Clerk, and create a matching plan id.

## Deploy to Google Cloud Run

Prerequisites: GCP project with billing enabled, `gcloud` CLI authenticated (`gcloud auth login`), APIs enabled: **Cloud Run**, **Artifact Registry**, **Cloud Build** (optional but recommended).

### GitHub Actions (from this repo)

In **GitHub → Settings → Secrets and variables → Actions**, add:

| Secret | Required | Purpose |
| --- | --- | --- |
| `GCP_PROJECT_ID` | Yes | GCP project id. |
| `GCP_REGION` | Yes | e.g. `europe-west1` or `us-central1` (used for AR + Cloud Run). |
| `GCP_SA_KEY` | Yes | **JSON** key for a deploy service account (see below). |
| `CLERK_JWKS_URL` | Yes | From Clerk dashboard (used by FastAPI to verify JWTs). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Public key; passed at **Docker build** for the static bundle. |
| `OPENROUTER_API_KEY` or `OPENAI_API_KEY` | At least one | LLM; OpenRouter is preferred. |
| `OPENAI_MODEL` | No | Defaults to `openai/gpt-4o-mini` in the workflow. |
| `CORS_ALLOW_ORIGINS_EXTRA` | No | Comma list of **additional** allowed origins (previews, local, etc.); the workflow always adds the Cloud Run URL. |

Pushes to **`main`** and **manual** runs of **Deploy to Google Cloud Run** build `linux/amd64`, push to **Artifact Registry** `medscribe-repo`, and deploy **Cloud Run** on port 8000. The workflow sets **`CORS_ALLOW_ORIGINS`** and, when you use OpenRouter, **`OPENROUTER_REFERER`**, to the service URL (first deploy: URL is applied in a follow-up `gcloud run services update` so it is not missing on the next run).

**Service account for `GCP_SA_KEY`:** create a key on a custom SA and grant it at least:

- `roles/serviceusage.serviceUsageAdmin` (so `gcloud services enable` works in CI, or pre-enable APIs and skip the need in some setups)
- `roles/artifactregistry.writer` (or `admin`) in the project for pushing images
- `roles/run.admin` (Cloud Run deploy/update)

Also grant `roles/iam.serviceAccountUser` on the **Cloud Run runtime** service account if the deployer must attach it (common default: project-number-compute@...). Tighter setups can use a dedicated key with [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) instead of a long‑lived JSON key.

`gcloud` `--set-env-vars` / `--update-env-vars` use **comma** separators. Values that contain a comma are awkward; in that case use [Secret Manager](https://cloud.google.com/secret-manager) or the Cloud Run console to set the variable.

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
  --set-env-vars "CLERK_JWKS_URL=https://...,OPENROUTER_API_KEY=..."

# Optional: --set-secrets to mount keys from Secret Manager, e.g. OPENROUTER_API_KEY=openrouter-key:latest
```

Prefer **Secret Manager** for `OPENROUTER_API_KEY` / `OPENAI_API_KEY` in production. For a quick demo you can paste them under **Edit service → Variables & secrets** (rotate keys after the course). Set `CORS_ALLOW_ORIGINS` and `OPENROUTER_REFERER` to your Cloud Run `https://...` URL (or use the included GitHub workflow, which does this for you when OpenRouter is used).

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
