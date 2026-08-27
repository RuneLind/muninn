/**
 * PR 0 of `mimir/plans/muninn-nav-vertex-models.mdx` — the MEASUREMENT.
 *
 * Team KI points NAV projects at GCP Vertex AI, in an EU/EØS region, and
 * forbids `global`. The plan reasoned about what that costs muninn from
 * Google's published region table. This script asks the API instead, against a
 * real project, and answers the three questions the PR slate branches on:
 *
 *   1. WHICH models does this project actually reach, in which region?
 *      Not "which does the table list" — an entitlement the project has never
 *      accepted looks identical to a region that does not carry the model, and
 *      only one of those is an engineering problem. Probe A separates them.
 *   2. Does Gemini 2.5 in `europe-north1` survive muninn's TOOL LOOP?
 *      That is the whole risk in the plan's PR 2, and the trigger for dropping
 *      PR 5. Probe B runs the real two-turn shape — call, tool result, answer —
 *      through the OpenAI-compatible endpoint `openai-compat` would use, with
 *      the one real tool buried in a field of decoys.
 *   3. Is `assertHaveAuth()` really the only muninn-side blocker on the
 *      "zero-code" Claude-on-Vertex path? Probe C runs the Agent SDK with BOTH
 *      Anthropic credentials removed from the environment and reports how far
 *      it gets. If it reaches a Vertex answer, the seam is proven and the fix
 *      is one line; if it dies before the network, the plan's Vei A is wrong.
 *
 *     VERTEX_PROJECT_ID=<your-gcp-project> bun scripts/smoke-vertex.ts
 *     … --probe=regions|gemini|claude-sdk    (default: all three)
 *
 * NO NAV VALUES LIVE HERE. Every project id, region and question set is env or
 * flag input; the defaults are Google's own public region names. The eight
 * built-in questions are generic, publicly-derivable phrasings about a public
 * NAV system (Melosys, the A1 form, EESSI) that a person could write from
 * nav.no — they are NOT drawn from any internal corpus. Point
 * `VERTEX_SMOKE_QUESTIONS` at a file (one question per line) to measure against
 * real ones without them entering this repo.
 *
 * Credentials come from ADC — `gcloud auth application-default login` on a
 * laptop, the workload-identity metadata server in a pod. No key material is
 * read, printed or stored.
 */

const PROJECT = (process.env.VERTEX_PROJECT_ID ?? "").trim();
const GEMINI_REGION = (process.env.VERTEX_REGION ?? "europe-north1").trim();
const GEMINI_MODEL = (process.env.VERTEX_GEMINI_MODEL ?? "gemini-2.5-flash").trim();
const CLAUDE_REGION = (process.env.VERTEX_CLAUDE_REGION ?? "europe-west1").trim();
const CLAUDE_MODEL = (process.env.VERTEX_CLAUDE_MODEL ?? "claude-sonnet-4-5").trim();

if (!PROJECT) {
  console.error("VERTEX_PROJECT_ID is required (the GCP project that owns the Vertex quota).");
  process.exit(2);
}

const probeArg = process.argv.find((a) => a.startsWith("--probe="))?.slice("--probe=".length);
const RUN = new Set(probeArg ? probeArg.split(",") : ["regions", "gemini", "claude-sdk"]);

/**
 * The regional API hosts, plus the two special ones that decide the plan.
 *
 * `eu` is the MULTI-REGION endpoint (`aiplatform.eu.rep.googleapis.com`), whose
 * whole promise is that processing stays inside the EU — the opposite of
 * `global`, which Team KI forbids precisely because the region is unknowable.
 * Whether the føring's "EU/EØS-regioner" covers it is question 1 to Team KI,
 * and this probe is what makes the question concrete: it reports what is
 * REACHABLE there, not whether it is allowed.
 *
 * `us-central1` is the CONTROL, and it is not decoration. A denial there tells
 * us the org policy is doing the enforcing rather than our own discipline — and
 * `constraints/gcp.restrictEndpointUsage` answers with a distinct message, so
 * "policy blocked this endpoint" never reads as "this region has no models".
 */
const REGION_HOSTS: { location: string; host: string; note?: string }[] = [
  { location: "europe-north1", host: "europe-north1-aiplatform.googleapis.com", note: "the nais region" },
  { location: "europe-west1", host: "europe-west1-aiplatform.googleapis.com" },
  { location: "europe-west4", host: "europe-west4-aiplatform.googleapis.com" },
  { location: "eu", host: "aiplatform.eu.rep.googleapis.com", note: "EU multi-region — open question 1" },
  { location: "us-central1", host: "us-central1-aiplatform.googleapis.com", note: "control: expected to be refused" },
];

const DEFAULT_QUESTIONS = [
  "Hva sier vår interne dokumentasjon om A1-søknader?",
  "Hvordan behandles en søknad om medlemskap i folketrygden ved arbeid i utlandet?",
  "Hva er forskjellen på en A1-attest og et medlemskapsvedtak?",
  "Hvilke SED-er sendes ved utsending av arbeidstaker til et annet EØS-land?",
  "Hvordan beregnes trygdeavgift for en person med inntekt i to land?",
  "Hva skjer når et annet land bestrider vår lovvalgsvurdering?",
  "Hvilke opplysninger trenger vi fra arbeidsgiver for å vurdere lovvalg?",
  "Hvordan håndterer vi en sak der arbeidstakeren jobber i flere land samtidig?",
];

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------

/**
 * ADC, in the two shapes this script can run under. The metadata server is
 * tried FIRST and with a short budget: in a pod it answers in single-digit
 * milliseconds, and off one it is an unroutable address that must not hang the
 * script before `gcloud` gets a turn.
 */
async function accessToken(): Promise<string> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(700) },
    );
    if (res.ok) {
      const body = (await res.json()) as { access_token?: string };
      if (body.access_token) return body.access_token;
    }
  } catch {
    // Not on GCE — fall through to gcloud.
  }
  const proc = Bun.spawn(["gcloud", "auth", "application-default", "print-access-token"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`no ADC token: metadata server unreachable and gcloud failed — ${err.slice(0, 300)}`);
  }
  return out;
}

/**
 * Every call carries `x-goog-user-project`. The project-scoped endpoints do not
 * need it; the publisher LISTING does — user ADC has no quota project of its
 * own and answers `SERVICE_DISABLED` without it, which reads exactly like the
 * Vertex API being switched off for the project. One header removes a whole
 * class of false diagnosis.
 */
function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-goog-user-project": PROJECT,
  };
}

// ---------------------------------------------------------------------------
// Probe A — what does this project actually reach, and where?
// ---------------------------------------------------------------------------

interface Availability {
  location: string;
  host: string;
  note?: string;
  status: number;
  /** Model ids, `name@versionId`, or null when the listing did not answer. */
  anthropic: string[] | null;
  gemini: string[] | null;
  /** The org-policy refusal, when that is what happened, rather than a count. */
  refusal?: string;
}

async function listPublisherModels(
  token: string,
  host: string,
  publisher: string,
): Promise<{ status: number; models: string[] | null; refusal?: string }> {
  const url = `https://${host}/v1beta1/publishers/${publisher}/models?pageSize=200`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(token), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return { status: 0, models: null, refusal: `transport: ${String((err as Error).message).slice(0, 160)}` };
  }
  const text = await res.text();
  if (!res.ok) {
    // The message matters more than the code: a 403 from
    // `constraints/gcp.restrictEndpointUsage` is the platform enforcing the
    // region rule, and is a PASS for our purposes, not a failure.
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch { /* keep the raw head */ }
    return { status: res.status, models: null, refusal: message };
  }
  const body = JSON.parse(text) as { publisherModels?: { name: string; versionId?: string }[] };
  const models = (body.publisherModels ?? []).map(
    (m) => `${m.name.split("/").pop()}@${m.versionId ?? "?"}`,
  );
  return { status: res.status, models };
}

async function probeRegions(token: string): Promise<Availability[]> {
  const rows: Availability[] = [];
  for (const { location, host, note } of REGION_HOSTS) {
    const [anthropic, google] = await Promise.all([
      listPublisherModels(token, host, "anthropic"),
      listPublisherModels(token, host, "google"),
    ]);
    rows.push({
      location,
      host,
      note,
      status: anthropic.status,
      anthropic: anthropic.models,
      gemini: google.models?.filter((m) => m.startsWith("gemini")) ?? null,
      ...(anthropic.refusal ? { refusal: anthropic.refusal } : {}),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Probe B — Gemini through the tool loop `openai-compat` would drive
// ---------------------------------------------------------------------------

/**
 * Decoys. muninn's melosys bot carries roughly forty MCP tools, and the plan
 * rates "the tool loop with ~40 tools is unproven on Gemini" as PR 2's whole
 * risk. Selecting the right tool out of one is not a measurement; selecting it
 * out of forty-one, from the middle of the list, is.
 */
const DECOY_TOOLS = [
  "read_file", "write_file", "list_dir", "git_log", "send_email", "calendar_add", "weather", "stock_price",
  "translate", "ocr", "resize_image", "transcode", "ping_host", "dns_lookup", "http_get", "sql_query",
  "redis_get", "s3_put", "kube_logs", "docker_ps", "jira_create", "slack_post", "github_pr", "npm_install",
  "pytest_run", "lint_code", "format_code", "deploy_app", "rollback", "metrics_query", "trace_span",
  "alert_ack", "user_lookup", "role_grant", "token_mint", "cache_purge", "queue_drain", "cron_add",
  "backup_run", "restore_run",
];

const REAL_TOOL = "research_knowledge";

function toolSet(): unknown[] {
  const fn = (name: string, description: string, arg: string) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: { [arg]: { type: "string" } }, required: [arg] },
    },
  });
  const decoys = DECOY_TOOLS.map((n, i) => fn(`tool_${i}_${n}`, `Unrelated utility ${i}`, "arg"));
  const real = fn(REAL_TOOL, "Search the internal knowledge base for documentation and prior cases", "query");
  // Buried at the midpoint: first-position and last-position selection are both
  // measurable artefacts of ordering rather than of the model choosing well.
  return [...decoys.slice(0, 20), real, ...decoys.slice(20)];
}

interface GeminiTurn {
  question: string;
  calledTool: string | null;
  /** Did the SECOND turn — the one fed a tool result — produce prose? */
  answered: boolean;
  answerHead: string;
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  error?: string;
}

async function probeGemini(token: string, questions: string[]): Promise<GeminiTurn[]> {
  const base =
    `https://${GEMINI_REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
    `/locations/${GEMINI_REGION}/endpoints/openapi/chat/completions`;
  const tools = toolSet();
  const results: GeminiTurn[] = [];

  for (const question of questions) {
    const started = performance.now();
    const row: GeminiTurn = {
      question, calledTool: null, answered: false, answerHead: "", ms: 0, promptTokens: 0, cachedTokens: 0,
    };
    try {
      const messages: unknown[] = [
        {
          role: "system",
          content: "Du er en assistent for saksbehandlere. Bruk verktøy når spørsmålet gjelder intern kunnskap.",
        },
        { role: "user", content: question },
      ];
      const post = async (body: unknown) => {
        const res = await fetch(base, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text) as {
          choices: { finish_reason: string; message: Record<string, unknown> }[];
          usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
      };

      const first = await post({ model: `google/${GEMINI_MODEL}`, messages, tools, max_tokens: 400 });
      const message = first.choices[0]?.message ?? {};
      const calls = (message.tool_calls ?? []) as { id: string; function: { name: string } }[];
      row.calledTool = calls[0]?.function.name ?? null;
      if (!row.calledTool) {
        row.answerHead = String(message.content ?? "").slice(0, 120);
        row.ms = Math.round(performance.now() - started);
        results.push(row);
        continue;
      }

      // The assistant message goes back VERBATIM. Gemini attaches an opaque
      // `extra_content.google.thought_signature` to a tool call, and the second
      // turn is rejected if it is stripped — a reconstructed message is not the
      // same message. `openai-compat`'s loop must preserve it too.
      messages.push(message);
      messages.push({
        role: "tool",
        tool_call_id: calls[0]!.id,
        content:
          "Treff i intern dokumentasjon: saken behandles i fagsystemet, og saksbehandler oppretter " +
          "riktig strukturert melding til det andre landet.",
      });
      const second = await post({ model: `google/${GEMINI_MODEL}`, messages, tools, max_tokens: 400 });
      const answer = String(second.choices[0]?.message?.content ?? "");
      row.answered = answer.trim().length > 0;
      row.answerHead = answer.slice(0, 120);
      row.promptTokens = second.usage?.prompt_tokens ?? 0;
      row.cachedTokens = second.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    } catch (err) {
      row.error = String((err as Error).message).slice(0, 220);
    }
    row.ms = Math.round(performance.now() - started);
    results.push(row);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Probe C — the Agent SDK on Vertex, with no Anthropic credential at all
// ---------------------------------------------------------------------------

interface SdkProbe {
  reachedVertex: boolean;
  apiKeySource: string | null;
  completed: boolean;
  detail: string;
  ms: number;
}

/**
 * The plan's "Vei A" claims Vertex is an env variable rather than a connector,
 * and that the only thing in the way is `assertHaveAuth()`. This proves or
 * disproves it WITHOUT touching that function: it deletes both Anthropic
 * credentials from this process's environment — Bun loads muninn's `.env`, so
 * they are usually present — and calls the SDK directly.
 *
 * Reading the outcome:
 *   - `apiKeySource: "none"` plus ANY answer from Vertex ⇒ the SDK authenticated
 *     with ADC and the transport works. Whatever fails after that is
 *     entitlement or model naming, not muninn's code.
 *   - a throw BEFORE any Vertex answer ⇒ Vei A is wrong and PR 5 is not a
 *     one-line change.
 */
async function probeClaudeSdk(): Promise<SdkProbe> {
  const started = performance.now();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_USE_VERTEX = "1";
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = PROJECT;
  process.env.CLOUD_ML_REGION = CLAUDE_REGION;
  if (CLAUDE_REGION === "eu") process.env.ANTHROPIC_VERTEX_BASE_URL = "https://aiplatform.eu.rep.googleapis.com";

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const probe: SdkProbe = { reachedVertex: false, apiKeySource: null, completed: false, detail: "", ms: 0 };
  try {
    const q = query({
      prompt: "Reply with the single word OK",
      options: { model: CLAUDE_MODEL, settingSources: [], permissionMode: "bypassPermissions", maxTurns: 1 },
    });
    for await (const event of q as AsyncGenerator<Record<string, unknown>, void>) {
      if (event.type === "system" && event.subtype === "init") {
        probe.apiKeySource = String(event.apiKeySource ?? "");
      }
      if (event.type === "result") {
        const text = String(event.result ?? "");
        // Vertex's own vocabulary for "the project cannot use this model".
        // Reaching THIS is the finding: the request was made and answered.
        probe.reachedVertex = /vertex|not available|access to it/i.test(text);
        probe.completed = event.subtype === "success" && /\bOK\b/.test(text) && !probe.reachedVertex;
        probe.detail = text.slice(0, 220);
      }
    }
  } catch (err) {
    const message = String((err as Error).message);
    if (/vertex|not available|access to it/i.test(message)) probe.reachedVertex = true;
    probe.detail = message.slice(0, 220);
  }
  probe.ms = Math.round(performance.now() - started);
  return probe;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function loadQuestions(): string[] {
  const path = process.env.VERTEX_SMOKE_QUESTIONS?.trim();
  if (!path) return DEFAULT_QUESTIONS;
  const text = require("node:fs").readFileSync(path, "utf8") as string;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new Error(`${path} has no questions`);
  return lines;
}

const summary: Record<string, unknown> = { project: "<redacted>", generatedAt: new Date().toISOString() };

const token = await accessToken();
console.log(`\nVertex smoke — project <VERTEX_PROJECT_ID>, ADC token acquired\n`);

if (RUN.has("regions")) {
  console.log("── Probe A: model availability, measured ──────────────────────");
  const rows = await probeRegions(token);
  summary.availability = rows;
  for (const r of rows) {
    const note = r.note ? `  (${r.note})` : "";
    console.log(`\n  ${r.location}${note}`);
    if (r.refusal) {
      console.log(`    anthropic: — HTTP ${r.status}: ${r.refusal.slice(0, 140)}`);
    } else {
      console.log(`    anthropic: ${r.anthropic?.length ?? 0} — ${r.anthropic?.join(", ") || "(none)"}`);
    }
    console.log(`    gemini:    ${r.gemini?.length ?? 0} — ${r.gemini?.join(", ") || "(none)"}`);
  }
  console.log("");
}

if (RUN.has("gemini")) {
  const questions = loadQuestions();
  console.log(`── Probe B: ${GEMINI_MODEL} @ ${GEMINI_REGION}, ${questions.length} questions, 41 tools ──`);
  const rows = await probeGemini(token, questions);
  summary.gemini = rows;
  const picked = rows.filter((r) => r.calledTool === REAL_TOOL).length;
  const answered = rows.filter((r) => r.answered).length;
  const errored = rows.filter((r) => r.error).length;
  for (const r of rows) {
    const verdict = r.error ? `ERROR ${r.error}` : `${r.calledTool ?? "(no tool)"} → ${r.answered ? "answered" : "no answer"}`;
    console.log(`  ${String(r.ms).padStart(5)}ms  ${verdict}`);
    if (r.error) console.log(`         q: ${r.question}`);
  }
  const rate = rows.length ? Math.round((100 * (rows.length - picked)) / rows.length) : 100;
  console.log(
    `\n  tool selected correctly: ${picked}/${rows.length}   answered after tool result: ${answered}/${rows.length}   errors: ${errored}` +
    `\n  failure rate: ${rate}%  (plan's PR-5 drop trigger: < 10%)\n`,
  );
  summary.geminiVerdict = { picked, answered, errored, total: rows.length, failureRatePct: rate };
}

if (RUN.has("claude-sdk")) {
  console.log(`── Probe C: Agent SDK → Vertex ${CLAUDE_REGION}/${CLAUDE_MODEL}, no Anthropic credential ──`);
  const probe = await probeClaudeSdk();
  summary.claudeSdk = probe;
  console.log(`  apiKeySource: ${probe.apiKeySource ?? "(never reported)"}`);
  console.log(`  reached Vertex: ${probe.reachedVertex}   turn completed: ${probe.completed}   ${probe.ms}ms`);
  console.log(`  detail: ${probe.detail}`);
  console.log(
    probe.reachedVertex || probe.completed
      ? "\n  ⇒ ADC authenticated the SDK with no ANTHROPIC_API_KEY. assertHaveAuth() is the only muninn-side blocker.\n"
      : "\n  ⇒ The SDK did NOT reach Vertex. Vei A needs more than a one-line change — re-read the plan.\n",
  );
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
}
