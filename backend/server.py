import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi_clerk_auth import (
    ClerkConfig,
    ClerkHTTPBearer,
    HTTPAuthorizationCredentials,
)
from openai import (
    APIError,
    APIStatusError,
    AuthenticationError,
    OpenAI,
    OpenAIError,
    RateLimitError,
)
from pydantic import BaseModel


class CopyAuthFromMedscribeASGI:
    """Next dev proxy can drop `Authorization` before the request hits Starlette. We cannot fix
    that in BaseHTTPMiddleware: the Request's Headers are already materialized, so mutating
    `scope` leaves Clerk reading an empty `Authorization` → 403 + detail \"Forbidden\".
    This ASGI layer runs *before* Request is built: copy `X-Medscribe-Auth` → `authorization`."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            raw = list(scope.get("headers", []))
            if not any(name == b"authorization" for name, _ in raw):
                for name, value in raw:
                    if name in (
                        b"x-medscribe-auth",
                        b"x-clerk-authorization",
                        b"x-forwarded-authorization",
                    ):
                        raw = list(raw) + [(b"authorization", value)]
                        break
            scope = {**scope, "headers": raw}
        await self.app(scope, receive, send)


app = FastAPI()

# CORS: `allow_origins=["*"]` is invalid together with `allow_credentials=True` in
# browsers — cross-origin fetches to local FastAPI would fail with "Failed to fetch".
# We use Authorization Bearer tokens, not cookies, so credentials are not needed.
_cors_raw = os.getenv(
    "CORS_ALLOW_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
)
cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()]
if not cors_origins:
    cors_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Must be registered after CORS so this is the *outer* ASGI (runs first; fixes scope before
# CORS and before Starlette builds Request — required for the Authorization copy to work).
app.add_middleware(CopyAuthFromMedscribeASGI)

clerk_config = ClerkConfig(
    jwks_url=os.environ["CLERK_JWKS_URL"],
    leeway=float(os.getenv("CLERK_JWT_LEEWAY", "10")),
)
clerk_guard = ClerkHTTPBearer(
    clerk_config,
    debug_mode=os.getenv("CLERK_JWT_DEBUG", "").lower() in ("1", "true", "yes"),
)


class Visit(BaseModel):
    patient_name: str
    date_of_visit: str
    notes: str


system_prompt = """
You are provided with notes written by a doctor from a patient's visit.
Your job is to summarize the visit for the doctor and provide an email.
Reply with exactly three sections with the headings:
### Summary of visit for the doctor's records
### Next steps for the doctor
### Draft of email to patient in patient-friendly language
"""


def user_prompt_for(visit: Visit) -> str:
    return f"""Create the summary, next steps and draft email for:
Patient Name: {visit.patient_name}
Date of Visit: {visit.date_of_visit}
Notes:
{visit.notes}"""


def _chat_client_and_model() -> tuple[OpenAI, str, str]:
    """Build OpenAI-compatible client. Returns (client, model_id, provider) where provider is openrouter|openai."""
    or_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if or_key:
        default_model = "openai/gpt-4o-mini"
        base = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
        # OpenRouter uses HTTP-Referer for app attribution; missing referer can cause 403/empty responses.
        referer = os.getenv("OPENROUTER_REFERER", "http://127.0.0.1:3000").strip()
        title = os.getenv("OPENROUTER_X_TITLE", "MedScribe AI").strip()
        headers: dict[str, str] = {
            "HTTP-Referer": referer,
            "X-Title": title,
            "X-OpenRouter-Title": title,
        }
        client = OpenAI(
            base_url=base,
            api_key=or_key,
            default_headers=headers,
        )
        m = (os.getenv("OPENAI_MODEL") or default_model).strip() or default_model
        return client, m, "openrouter"

    oa = os.getenv("OPENAI_API_KEY", "").strip()
    if oa:
        m = (os.getenv("OPENAI_MODEL") or "gpt-4o-mini").strip() or "gpt-4o-mini"
        return OpenAI(), m, "openai"

    m = (os.getenv("OPENAI_MODEL") or "gpt-4o-mini").strip() or "gpt-4o-mini"
    return OpenAI(), m, "openai"


def _llm_error_response(exc: APIError | OpenAIError) -> JSONResponse:
    """Map provider errors (e.g. OpenRouter 403 moderation) to JSON; preserve HTTP status when known."""
    detail: str
    if isinstance(exc, APIStatusError):
        detail = exc.message
        if exc.body and isinstance(exc.body, dict):
            err = exc.body.get("error")
            if isinstance(err, dict) and err.get("message"):
                detail = str(err["message"])
            elif isinstance(err, str):
                detail = err
        code = exc.status_code
        if 400 <= code < 600:
            return JSONResponse({"detail": detail}, status_code=code)
    detail = str(exc)
    return JSONResponse({"detail": f"LLM request failed: {detail}"}, status_code=502)


def _auth_error_message(provider: str) -> str:
    if provider == "openrouter":
        return (
            "OpenRouter rejected the API key (401). Get a key at https://openrouter.ai/keys "
            "and set OPENROUTER_API_KEY in your root .env, then restart the server."
        )
    return (
        "OpenAI rejected the API key (401). Create a key at https://platform.openai.com/api-keys "
        "and set OPENAI_API_KEY in your root .env, then restart the server."
    )


@app.post("/api/consultation")
def consultation_summary(
    visit: Visit,
    creds: HTTPAuthorizationCredentials = Depends(clerk_guard),
):
    _user_id = creds.decoded["sub"]
    or_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    oa_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not or_key and not oa_key:
        return JSONResponse(
            {
                "detail": (
                    "Set OPENROUTER_API_KEY (https://openrouter.ai) or OPENAI_API_KEY in the "
                    "server environment, then restart."
                )
            },
            status_code=400,
        )

    client, model, provider = _chat_client_and_model()
    user_prompt = user_prompt_for(visit)
    prompt = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    try:
        stream = client.chat.completions.create(
            model=model,
            messages=prompt,
            stream=True,
        )
    except AuthenticationError:
        return JSONResponse(
            {"detail": _auth_error_message(provider)},
            status_code=401,
        )
    except RateLimitError as exc:
        return JSONResponse(
            {"detail": f"LLM rate limit: {exc!s}"},
            status_code=429,
        )
    except (APIError, OpenAIError) as exc:
        return _llm_error_response(exc)
    except Exception as exc:  # pragma: no cover
        return JSONResponse(
            {"detail": f"Could not start LLM stream: {exc!s}"},
            status_code=500,
        )

    def event_stream():
        for chunk in stream:
            delta = chunk.choices[0].delta
            text = delta.content if delta and delta.content else None
            if text:
                lines = text.split("\n")
                for line in lines[:-1]:
                    yield f"data: {line}\n\n"
                    yield "data:  \n"
                yield f"data: {lines[-1]}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/health")
def health_check():
    return {"status": "healthy"}


static_path = Path("static")
if static_path.exists():

    @app.get("/")
    async def serve_root():
        return FileResponse(static_path / "index.html")

    app.mount("/", StaticFiles(directory="static", html=True), name="static")
