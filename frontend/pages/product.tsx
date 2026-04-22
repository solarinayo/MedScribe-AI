import { useState, FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import DatePicker from "react-datepicker";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@microsoft/fetch-event-source";
import {
  Protect,
  SignInButton,
  SignedIn,
  SignedOut,
  UserButton,
} from "@clerk/nextjs";

const requiredPlan =
  typeof process.env.NEXT_PUBLIC_CLERK_REQUIRED_PLAN === "string"
    ? process.env.NEXT_PUBLIC_CLERK_REQUIRED_PLAN.trim()
    : "";

/**
 * API base for the streaming endpoint.
 * - In `next dev`, the default is **http://127.0.0.1:8000** so the browser talks to
 *   FastAPI directly. The Next.js dev *rewrite* proxy is known to drop or mishandle
 *   `Authorization`, which makes Clerk return 403 Forbidden.
 * - In production (`next build` / Docker / Cloud Run), `NODE_ENV` is "production" and
 *   the default is same-origin: `/api/consultation`.
 * - `NEXT_PUBLIC_API_ORIGIN` overrides. Set `NEXT_PUBLIC_USE_DEV_PROXY=1` to use the
 *   rewrite in dev only (if you have fixed the proxy, or for experiments).
 */
const useDevProxy =
  process.env.NEXT_PUBLIC_USE_DEV_PROXY === "1" ||
  process.env.NEXT_PUBLIC_USE_DEV_PROXY === "true";
const envOrigin = (process.env.NEXT_PUBLIC_API_ORIGIN ?? "").replace(/\/$/, "");
const apiBase =
  envOrigin ||
  (process.env.NODE_ENV === "development" && !useDevProxy
    ? "http://127.0.0.1:8000"
    : "");
const consultationStreamUrl = apiBase
  ? `${apiBase}/api/consultation`
  : "/api/consultation";

function ConsultationForm() {
  const { getToken } = useAuth();

  const [patientName, setPatientName] = useState("");
  const [visitDate, setVisitDate] = useState<Date | null>(new Date());
  const [notes, setNotes] = useState("");

  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setOutput("");
    setLoading(true);

    const jwt = await getToken();
    if (!jwt) {
      setOutput("Authentication required");
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let buffer = "";

    try {
      await fetchEventSource(consultationStreamUrl, {
        signal: controller.signal,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
          // Next dev proxy may strip Authorization; FastAPI also reads X-Medscribe-Auth
          "X-Medscribe-Auth": `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          patient_name: patientName,
          date_of_visit: visitDate?.toISOString().slice(0, 10),
          notes,
        }),
        async onopen(res) {
          const ct = res.headers.get("content-type") ?? "";
          if (res.ok && ct.startsWith(EventStreamContentType)) {
            return;
          }
          const text = await res.text();
          let message = text;
          try {
            const parsed = JSON.parse(text) as { detail?: string };
            if (parsed?.detail) {
              message = parsed.detail;
            }
          } catch {
            /* not JSON */
          }
          if (!res.ok) {
            throw new Error(
              `API error ${res.status}: ${message.slice(0, 2000)}`,
            );
          }
          throw new Error(
            `Expected ${EventStreamContentType}, got ${ct}: ${message.slice(0, 500)}`,
          );
        },
        onmessage(ev) {
          buffer += ev.data;
          setOutput(buffer);
        },
        onclose() {
          setLoading(false);
        },
        onerror(err) {
          console.error("SSE error:", err);
          controller.abort();
          setLoading(false);
          const asErr = err instanceof Error ? err.message : String(err);
          const networkHint =
            "**Could not reach the API (is FastAPI on :8000 running?).**\n\n" +
            "Run from repo root: `./scripts/dev-api.sh` in a second terminal, " +
            "or `http://127.0.0.1:8000/health` should return `{\"status\":\"healthy\"}`. " +
            "If you use a VPN, try disabling it (some block `127.0.0.1`).";
          const isNetwork =
            asErr.includes("Failed to fetch") ||
            asErr.includes("NetworkError") ||
            asErr.includes("fetch");
          setOutput((prev) => prev || (isNetwork ? networkHint : `**${asErr}**`));
          throw err;
        },
      });
    } catch (e) {
      setLoading(false);
      const msg = e instanceof Error ? e.message : String(e);
      setOutput(
        (prev) =>
          prev || (msg ? `**Error:** ${msg}` : "Request failed."),
      );
    }
  }

  return (
    <div className="container mx-auto px-4 py-12 max-w-3xl">
      <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-8">
        Consultation Notes
      </h1>

      <form
        onSubmit={handleSubmit}
        className="space-y-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8"
      >
        <div className="space-y-2">
          <label
            htmlFor="patient"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Patient Name
          </label>
          <input
            id="patient"
            type="text"
            required
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
            placeholder="Enter patient's full name"
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="date"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Date of Visit
          </label>
          <DatePicker
            id="date"
            selected={visitDate}
            onChange={(d: Date | null) => setVisitDate(d)}
            dateFormat="yyyy-MM-dd"
            placeholderText="Select date"
            required
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="notes"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Consultation Notes
          </label>
          <textarea
            id="notes"
            required
            rows={8}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
            placeholder="Enter detailed consultation notes..."
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
        >
          {loading ? "Generating Summary..." : "Generate Summary"}
        </button>
      </form>

      {output ? (
        <section className="mt-8 bg-gray-50 dark:bg-gray-800 rounded-xl shadow-lg p-8">
          <div className="markdown-content prose prose-blue dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {output}
            </ReactMarkdown>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PlanRequiredFallback() {
  return (
    <div className="container mx-auto px-4 py-12">
      <header className="text-center mb-12">
        <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-4">
          Healthcare Professional Plan
        </h1>
        <p className="text-gray-600 dark:text-gray-400 text-lg mb-8">
          Streamline your patient consultations with AI-powered summaries
        </p>
      </header>
      <div className="max-w-xl mx-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-8 text-center shadow-lg">
        <p className="text-gray-700 dark:text-gray-300 mb-4">
          Your account needs the{" "}
          <span className="font-semibold">{requiredPlan}</span> Clerk Billing plan
          to open this tool.
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          In Clerk, enable Billing, create a plan with this identifier, and assign
          it to your user—or clear{" "}
          <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">
            NEXT_PUBLIC_CLERK_REQUIRED_PLAN
          </code>{" "}
          in <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">.env.local</code> to
          require only sign-in (no paid plan) while you develop.
        </p>
        <a
          href="https://dashboard.clerk.com/last-active?path=billing/settings"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-6 rounded-lg transition-colors"
        >
          Open Clerk Billing settings
        </a>
      </div>
    </div>
  );
}

export default function Product() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <div className="absolute top-4 right-4">
        <UserButton showName />
      </div>

      {requiredPlan ? (
        <Protect plan={requiredPlan} fallback={<PlanRequiredFallback />}>
          <ConsultationForm />
        </Protect>
      ) : (
        <>
          <SignedIn>
            <ConsultationForm />
          </SignedIn>
          <SignedOut>
            <div className="container mx-auto px-4 py-24 max-w-lg text-center">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                Sign in to continue
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mb-8">
                No subscription plan is required in this environment (Clerk free
                tier for auth is enough).
              </p>
              <SignInButton mode="modal">
                <button
                  type="button"
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-8 rounded-lg transition-colors"
                >
                  Sign in
                </button>
              </SignInButton>
            </div>
          </SignedOut>
        </>
      )}
    </main>
  );
}
