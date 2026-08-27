/**
 * A Vertex AI availability + tool-loop MEASUREMENT.
 *
 * Some deployments must run their model calls on GCP Vertex AI, pinned to
 * explicit regions, with the `global` region off the table. Which models that
 * leaves you is a question Google's published region table answers only
 * approximately — it lists what EXISTS, not what your project can CALL. This
 * script asks the API instead, against a real project, and answers the three
 * questions such a migration turns on:
 *
 *   1. WHICH models can this project actually CALL, in which region? Not which
 *      the catalogue lists — those are different facts, and the difference is
 *      the whole finding. `publishers/*\/models` is the public catalogue for a
 *      host; a project that has never accepted a partner model's terms, or has
 *      zero quota for it, is listed identically to one that can call it. So
 *      probe A lists AND THEN DIALS every listed model with the cheapest call
 *      that exists, and reports four outcomes that mean four different things:
 *      reachable, entitled-but-no-quota (429), not-available (404), denied.
 *   2. Does Gemini 2.5 in `europe-north1` survive muninn's TOOL LOOP? That is
 *      the risk in moving a bot to Gemini at all, and the thing a region
 *      decision turns on. Probe B runs the real two-turn shape — call, tool result, answer —
 *      through the OpenAI-compatible endpoint `openai-compat` would use, with
 *      the one real tool buried in a field of decoys.
 *   3. Is `assertHaveAuth()` really the only muninn-side blocker on the
 *      "zero-code" Claude-on-Vertex path? Probe C runs the Agent SDK with BOTH
 *      Anthropic credentials removed from the environment and CLASSIFIES how
 *      far it got — reached Vertex, never left the machine, or unknown.
 *
 *     VERTEX_PROJECT_ID=<your-gcp-project> bun scripts/smoke-vertex.ts
 *     … --probe=regions|gemini|claude-sdk   (comma-separated; default: all)
 *     … --json                              (JSON on stdout, prose on stderr)
 *
 * NOTHING DEPLOYMENT-SPECIFIC LIVES HERE, and nothing leaks at RUNTIME either:
 * every project id, region and question is env or flag input, the defaults are
 * Google's own public region names, and every line printed — including verbatim
 * server error messages, which name the project — goes through `redact()`
 * first. The twenty built-in questions are invented placeholders about a
 * fictional internal handbook, there only to give the tool loop something
 * plausible to retrieve against. Point `VERTEX_SMOKE_QUESTIONS` at a file (one
 * question per line, `#` comments) to measure against your own — but note that
 * `--json` then carries them verbatim in its output, so keep that file out of
 * the repo.
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

/**
 * Gemini 2.5 Flash spends thinking tokens inside the SAME budget as its answer,
 * so a small cap produces an empty `content` with `finish_reason: "length"` —
 * which reads exactly like "the tool loop failed to answer". Generous, because
 * the thing being measured is whether the loop completes, not how terse it is.
 * The bucket for it exists anyway (`truncated`), because a budget can never be
 * proven large enough.
 */
const ANSWER_MAX_TOKENS = 2048;

const KNOWN_PROBES = ["regions", "gemini", "claude-sdk"] as const;
const JSON_MODE = process.argv.includes("--json");
/** Prose goes to stderr under `--json` so `… --json | jq` works. */
const say = (line = "") => (JSON_MODE ? console.error(line) : console.log(line));

if (!PROJECT) {
  console.error("VERTEX_PROJECT_ID is required (the GCP project that owns the Vertex quota).");
  process.exit(2);
}

// The flag being PRESENT is the signal, not its value being non-empty:
// `--probe=` slices to `""`, which is falsy, so a plain `arg ? … : all` ran
// EVERY probe — ~40 API calls, 20 model turns and the SDK — on a plain typo.
const probeFlag = process.argv.find((a) => a.startsWith("--probe="));
const requested = probeFlag === undefined
  ? [...KNOWN_PROBES]
  : probeFlag.slice("--probe=".length).split(",").map((p) => p.trim()).filter(Boolean);
const unknownProbes = requested.filter((p) => !(KNOWN_PROBES as readonly string[]).includes(p));
if (unknownProbes.length > 0 || requested.length === 0) {
  // Silently running nothing and exiting 0 is the worst answer a measurement
  // tool can give: "measured, all fine" and "measured nothing" then look the same.
  console.error(
    unknownProbes.length > 0
      ? `--probe: unknown ${JSON.stringify(unknownProbes)} — expected some of ${KNOWN_PROBES.join(", ")}`
      : `--probe: named no probe — expected some of ${KNOWN_PROBES.join(", ")}`,
  );
  process.exit(2);
}
const RUN = new Set(requested);

/**
 * Every string that reaches stdout, stderr or `--json` passes through here.
 *
 * Not paranoia about our own literals — about the SERVER's. Google's errors
 * quote the resource, so a refusal reads `Access to projects/<the real id>
 * through endpoint … was denied`, and that line is exactly what a person pastes
 * into a public plan or PR. Redacting only the header line gave false
 * confidence.
 */
function redact(text: string): string {
  return text
    // FIRST, and this is the half a literal-id replace misses: Google's openapi
    // endpoint resolves the id to the project NUMBER in its errors, so a message
    // reads `projects/594181726752/locations/…` and the configured id never
    // appears at all. A number is just as identifying and just as pasteable.
    // Matching the `projects/<x>` SHAPE catches both, plus any project we did
    // not configure.
    .replace(/projects\/[A-Za-z0-9_.:-]+/g, "projects/<project>")
    // Google's quota messages carry the number with no `projects/` in front:
    // `… for consumer 'project_number:594181726752'`. Probe A's whole finding is
    // a family of 429s, so that is exactly the message most likely to be pasted.
    // A bare long-digit sweep is safe here because nothing this script prints —
    // latencies, token counts, model ids — reaches nine digits.
    .replace(/\b\d{9,}\b/g, "<number>")
    // Then the configured id anywhere else it appears. Guarded on length: a
    // three-character id would rewrite unrelated substrings (`api` inside
    // `aiplatform`), and GCP project ids are at least six characters.
    .split(PROJECT.length >= 6 ? PROJECT : "\u0000").join("<project>");
}

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
  let proc;
  try {
    proc = Bun.spawn(["gcloud", "auth", "application-default", "print-access-token"], {
      stdout: "pipe", stderr: "pipe",
    });
  } catch {
    // `Bun.spawn` THROWS for a binary that is not on PATH, so without this the
    // careful message below is unreachable in the commonest case of all.
    throw new Error(
      "no ADC token: not on GCE and `gcloud` is not on PATH — install the Google Cloud SDK and " +
      "run `gcloud auth application-default login`",
    );
  }
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(
      `no ADC token: metadata server unreachable and gcloud failed — ${redact(err).slice(0, 300)}`,
    );
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

interface Attempt { status: number; body: string; transportError?: string }

/**
 * One HTTP attempt, retried ONCE on 429 or 5xx.
 *
 * Not robustness for its own sake: probe A classifies 429 as a MEANINGFUL
 * outcome ("entitled, no quota"), and a transient 429 from a burst of our own
 * calls would be indistinguishable from a standing quota of zero. One retry
 * after a second separates the two well enough to act on, and the report says
 * when a retry happened.
 */
async function attempt(
  url: string, token: string, init: RequestInit = {}, timeoutMs = 30_000,
): Promise<Attempt & { retried: boolean }> {
  let retried = false;
  for (let round = 0; round < 2; round++) {
    try {
      const res = await fetch(url, {
        ...init, headers: authHeaders(token), signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && round === 0) {
        retried = true;
        await Bun.sleep(1000);
        continue;
      }
      return { status: res.status, body, retried };
    } catch (err) {
      const message = String((err as Error).message);
      // A TIMEOUT is not retried. The retry exists to disambiguate a transient
      // 429 from a standing quota of zero; retrying an expired budget only
      // doubles the wait, and at 60 s per Gemini turn that is forty minutes
      // across twenty questions. Other transport failures (DNS, reset) get one.
      // `AbortSignal.timeout` reports `name: "TimeoutError"` / "The operation
      // timed out." — measured. Matched on the NAME plus that exact phrasing,
      // deliberately not a loose /timed out|abort/: that also matched
      // `ETIMEDOUT`, a transport failure the comment below promises to retry.
      const timedOut = (err as Error).name === "TimeoutError"
        || (err as Error).name === "AbortError"
        || /operation timed out|operation was aborted/i.test(message);
      if (round === 0 && !timedOut) { retried = true; await Bun.sleep(1000); continue; }
      return { status: 0, body: "", transportError: message.slice(0, 160), retried };
    }
  }
  /* c8 ignore next */ throw new Error("unreachable");
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } } | { error?: { message?: string } }[];
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    if (one?.error?.message) return one.error.message;
  } catch { /* fall through to the raw head */ }
  return body.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Probe A — what can this project CALL, and where?
// ---------------------------------------------------------------------------

/**
 * The four answers a dial can give, and why each is its own word.
 *
 * `no-quota` is the one that earns the whole probe. Measured 2026-08-27:
 * `claude-sonnet-4-5` on the EU multi-region endpoint answers **429 Quota
 * exceeded**, while `claude-sonnet-5` on the same endpoint answers 404. Those
 * are opposite situations — one is a quota request, the other is "this project
 * cannot have that model" — and the catalogue listing shows both identically.
 */
type Reach = "reachable" | "no-quota" | "not-available" | "denied" | `http-${number}` | "transport-error";

interface ModelReach { model: string; reach: Reach; detail?: string; retried?: boolean }

interface Availability {
  location: string;
  host: string;
  note?: string;
  /** Per publisher, because a refusal on one says nothing about the other — and
   *  folding a refused listing into "0 models" is the exact false diagnosis
   *  this probe exists to prevent. */
  publishers: Record<string, { listed: string[] | null; refusal?: string; status: number; dialled: ModelReach[] }>;
}

const REGION_HOSTS: { location: string; host: string; note?: string }[] = [
  { location: "europe-north1", host: "europe-north1-aiplatform.googleapis.com", note: "the deployment region" },
  { location: "europe-west1", host: "europe-west1-aiplatform.googleapis.com" },
  { location: "europe-west4", host: "europe-west4-aiplatform.googleapis.com" },
  { location: "eu", host: "aiplatform.eu.rep.googleapis.com", note: "EU multi-region — open question 1" },
  { location: "us-central1", host: "us-central1-aiplatform.googleapis.com", note: "control: expected to be refused" },
];

function classify(status: number, body: string): Reach {
  if (status === 200) return "reachable";
  if (status === 429) return "no-quota";
  if (status === 404) return "not-available";
  if (status === 403) return "denied";
  if (status === 0) return "transport-error";
  // A 400 from a model that exists is a payload problem and must not be read as
  // an availability answer; it is surfaced with its own code and its message.
  void body;
  return `http-${status}` as Reach;
}

/**
 * The cheapest call that proves reachability, per publisher.
 *
 * Gemini has `:countTokens`, which runs no inference and bills nothing.
 *
 * ⚠️ The Anthropic publisher does not, and the way it says so is a TRAP. Sent
 * the Gemini-shaped `:countTokens` body — exactly what a shared code path would
 * have sent — it answers **404 NOT_FOUND**, and `classify()` maps 404 to
 * `not-available`. Every Anthropic model in every region would then have read
 * "✘ not available", silently and plausibly, wiping out the five-model 429
 * finding this probe exists to produce. (Sent an Anthropic-shaped body it
 * answers 400 "Unknown name anthropic_version" instead — a truer error, from an
 * experiment no real caller would run.) So the dial is asymmetric on purpose:
 * `:rawPredict` with `max_tokens: 1`, a real but negligible generation.
 */
async function dial(
  token: string, host: string, location: string, publisher: string, model: string,
): Promise<ModelReach> {
  const base = `https://${host}/v1/projects/${PROJECT}/locations/${location}/publishers/${publisher}/models/${model}`;
  const [url, payload] = publisher === "anthropic"
    ? [`${base}:rawPredict`,
       { anthropic_version: "vertex-2023-10-16", messages: [{ role: "user", content: "x" }], max_tokens: 1 }]
    : [`${base}:countTokens`, { contents: [{ role: "user", parts: [{ text: "x" }] }] }];
  const res = await attempt(url, token, { method: "POST", body: JSON.stringify(payload) });
  const reach = classify(res.status, res.body);
  return {
    model,
    reach,
    ...(reach === "reachable" ? {} : { detail: redact(res.transportError ?? errorMessage(res.body)).slice(0, 160) }),
    ...(res.retried ? { retried: true } : {}),
  };
}

async function probeRegions(token: string): Promise<Availability[]> {
  const rows: Availability[] = [];
  for (const { location, host, note } of REGION_HOSTS) {
    const publishers: Availability["publishers"] = {};
    for (const publisher of ["anthropic", "google"]) {
      const res = await attempt(`https://${host}/v1beta1/publishers/${publisher}/models?pageSize=200`, token);
      if (res.status !== 200) {
        publishers[publisher] = {
          listed: null, status: res.status, dialled: [],
          refusal: redact(res.transportError ?? errorMessage(res.body)),
        };
        continue;
      }
      const body = JSON.parse(res.body) as { publisherModels?: { name: string; versionId?: string }[] };
      const listed = (body.publisherModels ?? []).map((m) => m.name.split("/").pop() as string);
      // Only the text models are dialled: the TTS, live-audio, embedding and
      // image variants take a different payload, and a 400 from them would be
      // noise in a column whose whole job is availability. BOTH counts are
      // reported — labelling the filtered number "catalogue lists N" produced a
      // third number that is neither the catalogue nor the reachable set, in the
      // one probe whose entire thesis is that those two differ.
      const dialable = listed.filter(
        (m) => publisher === "anthropic" || /^gemini-[\d.]+-(flash|pro)(-lite)?$/.test(m),
      );
      const dialled: ModelReach[] = [];
      for (const model of dialable) dialled.push(await dial(token, host, location, publisher, model));
      publishers[publisher] = { listed, status: res.status, dialled };
    }
    rows.push({ location, host, note, publishers });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Probe B — Gemini through the tool loop `openai-compat` would drive
// ---------------------------------------------------------------------------

/**
 * Decoys. A muninn bot with a full MCP surface carries roughly forty tools, and
 * whether a model still picks the right one at that scale is the open question.
 * Selecting the right tool out of one is not a measurement; selecting it out of
 * forty-one, from the middle of the list, is.
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
      name, description,
      parameters: { type: "object", properties: { [arg]: { type: "string" } }, required: [arg] },
    },
  });
  const decoys = DECOY_TOOLS.map((n, i) => fn(`tool_${i}_${n}`, `Unrelated utility ${i}`, "arg"));
  const real = fn(REAL_TOOL, "Search the internal knowledge base for documentation and prior cases", "query");
  // Buried at the midpoint: first-position and last-position selection are both
  // measurable artefacts of ordering rather than of the model choosing well.
  return [...decoys.slice(0, 20), real, ...decoys.slice(20)];
}

/**
 * Five outcomes, because the earlier three collapsed cases that decide
 * DIFFERENT PRs into one number.
 *
 *   `loop-completed`   tool called, tool result fed back, prose came out. The
 *                      only outcome that is evidence the loop works.
 *   `loop-broken`      tool called and the second turn produced nothing. The
 *                      only outcome that is evidence AGAINST it, and the one a
 *                      "tool selected correctly: 8/8" headline hid entirely.
 *   `truncated`        second turn hit the token budget. Separate because the
 *                      cause is ours, not the model's.
 *   `answered-no-tool` the model answered directly. Neither passes nor fails
 *                      the loop trigger — it never entered the loop — so it is
 *                      excluded from the rate and reported on its own line.
 *   `no-answer-no-tool` first turn produced neither a tool call nor prose.
 *                      Also never entered the loop, so also excluded — folding
 *                      it into `loop-broken` inflated the very number the drop
 *                      trigger is read off, with a row that had no second turn.
 *   `error`            an HTTP failure. Excluded from the rate too when it hit
 *                      the FIRST turn, for the same reason: a 429 or a 500 on
 *                      question one is not the tool loop failing.
 */
type TurnOutcome =
  | "loop-completed" | "loop-broken" | "truncated" | "answered-no-tool" | "no-answer-no-tool" | "error";

interface GeminiTurn {
  question: string;
  outcome: TurnOutcome;
  /** Was a tool actually called, i.e. did the two-turn loop start? The rate's
   *  denominator, and NOT derivable from `outcome`: an `error` row can be either
   *  a first-turn HTTP failure (never entered) or a second-turn one (entered
   *  and broke), and folding the two together reported "loop entered: 2/2" on a
   *  run against a model that does not exist. */
  enteredLoop: boolean;
  calledTool: string | null;
  finishReason: string | null;
  answerHead: string;
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  retried?: boolean;
  error?: string;
}

async function probeGemini(token: string, questions: string[]): Promise<GeminiTurn[]> {
  const url =
    `https://${GEMINI_REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
    `/locations/${GEMINI_REGION}/endpoints/openapi/chat/completions`;
  const tools = toolSet();
  const results: GeminiTurn[] = [];

  for (const question of questions) {
    const started = performance.now();
    const row: GeminiTurn = {
      question, outcome: "error", enteredLoop: false, calledTool: null, finishReason: null,
      answerHead: "", ms: 0, promptTokens: 0, cachedTokens: 0,
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
        const res = await attempt(url, token, { method: "POST", body: JSON.stringify(body) }, 60_000);
        if (res.retried) row.retried = true;
        if (res.status !== 200) {
          throw new Error(`HTTP ${res.status}: ${redact(res.transportError ?? errorMessage(res.body)).slice(0, 200)}`);
        }
        return JSON.parse(res.body) as {
          choices: { finish_reason: string; message: Record<string, unknown> }[];
          usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
      };

      const first = await post({ model: `google/${GEMINI_MODEL}`, messages, tools, max_tokens: ANSWER_MAX_TOKENS });
      const message = first.choices[0]?.message ?? {};
      const calls = (message.tool_calls ?? []) as { id: string; function: { name: string } }[];
      row.calledTool = calls[0]?.function.name ?? null;
      row.finishReason = first.choices[0]?.finish_reason ?? null;

      if (!row.calledTool) {
        // No branch here is a LOOP failure: no tool was called, so there was no
        // second turn to break. All three are excluded from the rate — but they
        // are three, not two. `truncated` is checked FIRST because that cause is
        // OURS: Gemini spends thinking tokens inside the same budget, so a small
        // `ANSWER_MAX_TOKENS` produces an empty `content` with
        // `finish_reason: "length"`, and reporting that as `no-answer-no-tool`
        // points the reader at the model when the cause is a constant in this
        // file. (An earlier round deleted this arm instead of re-routing it.)
        row.answerHead = String(message.content ?? "").slice(0, 120);
        row.outcome = row.finishReason === "length" ? "truncated"
          : row.answerHead.trim() ? "answered-no-tool" : "no-answer-no-tool";
        row.ms = Math.round(performance.now() - started);
        results.push(row);
        continue;
      }
      // Past this point a tool WAS called, so the loop was entered and its
      // outcome counts.
      row.enteredLoop = true;

      // The assistant message goes back VERBATIM. Gemini attaches an opaque
      // `extra_content.google.thought_signature` to a tool call; measured
      // 2026-08-27 against this endpoint, stripping it is ACCEPTED (both
      // directions returned 200), so this is not a preservation requirement to
      // build `openai-compat` around — it is simply the honest thing to send,
      // and the field is documented as carrying reasoning state the next turn
      // may use.
      messages.push(message);
      messages.push({
        role: "tool",
        tool_call_id: calls[0]!.id,
        content:
          "Treff i håndboken: saken registreres i fagsystemet, og saksbehandler oppretter " +
          "riktig strukturert melding til motparten.",
      });
      const second = await post({ model: `google/${GEMINI_MODEL}`, messages, tools, max_tokens: ANSWER_MAX_TOKENS });
      const choice = second.choices[0];
      const answer = String(choice?.message?.content ?? "");
      row.finishReason = choice?.finish_reason ?? null;
      row.answerHead = answer.slice(0, 120);
      row.promptTokens = second.usage?.prompt_tokens ?? 0;
      row.cachedTokens = second.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      row.outcome = answer.trim()
        ? "loop-completed"
        : row.finishReason === "length" ? "truncated" : "loop-broken";
    } catch (err) {
      row.outcome = "error";
      row.error = redact(String((err as Error).message)).slice(0, 220);
    }
    row.ms = Math.round(performance.now() - started);
    results.push(row);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Probe C — the Agent SDK on Vertex, with no Anthropic credential at all
// ---------------------------------------------------------------------------

/**
 * Four outcomes, and `unknown` is a real one.
 *
 * The question is only "did a request reach Vertex on ADC alone", so the answer
 * must not be inferred from vocabulary. A 403 `PERMISSION_DENIED` on a project
 * the caller cannot use IS Vertex answering — the exact proof this probe wants —
 * and a regex looking for the word "vertex" called that a failure and printed
 * the opposite conclusion. Anything that does not clearly land in one of the
 * three decided buckets is reported as `unknown` with the raw detail, rather
 * than as a verdict.
 */
type SdkOutcome = "completed" | "reached-vertex" | "did-not-reach" | "timeout" | "unknown";

interface SdkProbe {
  outcome: SdkOutcome;
  /** Reported IDENTICALLY whether or not the request left the machine, so it
   *  corroborates nothing on its own — printed because it is the direct
   *  evidence that no Anthropic credential was in play. */
  apiKeySource: string | null;
  detail: string;
  ms: number;
}

const SDK_TIMEOUT_MS = 60_000;

/** Vertex/Google answering: an HTTP status from the API, or one of Google's own
 *  status enums, or the CLI's own model-availability message. */
const REACHED_VERTEX = /API Error: \d{3}|PERMISSION_DENIED|NOT_FOUND|RESOURCE_EXHAUSTED|UNAUTHENTICATED|INVALID_ARGUMENT|not available on your vertex deployment/i;
/** The request never left: transport, DNS, TLS. */
const NEVER_LEFT = /ConnectionRefused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|socket hang up|unable to (verify|get local)/i;

async function probeClaudeSdk(): Promise<SdkProbe> {
  const started = performance.now();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_USE_VERTEX = "1";
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = PROJECT;
  process.env.CLOUD_ML_REGION = CLAUDE_REGION;
  if (CLAUDE_REGION === "eu") process.env.ANTHROPIC_VERTEX_BASE_URL = "https://aiplatform.eu.rep.googleapis.com";

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const probe: SdkProbe = { outcome: "unknown", apiKeySource: null, detail: "", ms: 0 };

  const q = query({
    prompt: "Reply with the single word OK",
    options: { model: CLAUDE_MODEL, settingSources: [], permissionMode: "bypassPermissions", maxTurns: 1 },
  });
  const run = async () => {
    for await (const event of q as AsyncGenerator<Record<string, unknown>, void>) {
      if (event.type === "system" && event.subtype === "init") probe.apiKeySource = String(event.apiKeySource ?? "");
      if (event.type === "result") {
        const text = String(event.result ?? "");
        probe.detail = redact(text).slice(0, 220);
        probe.outcome = REACHED_VERTEX.test(text) ? "reached-vertex"
          : NEVER_LEFT.test(text) ? "did-not-reach"
          : event.subtype === "success" && text.trim() ? "completed"
          : "unknown";
      }
    }
  };

  // ⚠️ The timer is held so it can be CLEARED, and the generator is closed in
  // `finally`. An un-cleared `setTimeout` inside a `Promise.race` keeps Bun's
  // event loop alive, so the happy path printed its result in 3 s and then sat
  // there for the full 60 s before exiting; on the timeout path the CLI child
  // was orphaned and the script was still alive minutes later. An earlier
  // comment here asserted "the script exits regardless", which was the opposite
  // of what it did — and an unmeasured claim in a file whose thesis is measure,
  // do not reason.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`__timeout__ after ${SDK_TIMEOUT_MS}ms`)), SDK_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const message = String((err as Error).message);
    probe.detail = redact(message).slice(0, 220);
    probe.outcome = message.startsWith("__timeout__") ? "timeout"
      : REACHED_VERTEX.test(message) ? "reached-vertex"
      : NEVER_LEFT.test(message) ? "did-not-reach"
      : "unknown";
  } finally {
    // BEFORE the teardown below: awaiting `q.return()` adds ~2 s of CLI shutdown,
    // and reporting `10068ms` beside "TIMED OUT after 8000ms" made the script
    // contradict itself in a file whose thesis is that printed numbers are
    // measurements.
    probe.ms = Math.round(performance.now() - started);
    if (timer) clearTimeout(timer);
    // Closes the generator, which is what terminates the CLI subprocess. The
    // race leaves it mid-iteration on the timeout path, and without this the
    // child outlives the script.
    await (q as AsyncGenerator<unknown, void>).return?.(undefined).catch(() => {});
  }
  return probe;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Twenty, because a 10% threshold cannot be measured on eight — one bad row out
 * of eight is already 12.5%.
 *
 * INVENTED placeholders about a fictional internal handbook, not drawn from any
 * corpus. They exist to give the tool loop something plausible to retrieve
 * against: what is being measured is whether the model picks the right tool out
 * of forty-one and survives the round trip, not what it knows. Point
 * `VERTEX_SMOKE_QUESTIONS` at your own set to measure against real traffic.
 */
const DEFAULT_QUESTIONS = [
  "Hva sier håndboken om hvordan vi registrerer en ny sak?",
  "Hvordan behandles en henvendelse som kommer inn utenfor åpningstid?",
  "Hva er forskjellen på et forhåndsvarsel og et endelig svar?",
  "Hvilke felter er obligatoriske før en sak kan sendes videre?",
  "Hvordan beregnes fristen når en sak settes på vent?",
  "Hva gjør vi når motparten bestrider vurderingen vår?",
  "Hvilke opplysninger må vi ha fra innsender før vi kan starte?",
  "Hvordan håndterer vi en sak som berører flere avdelinger samtidig?",
  "Hva er rutinen når en sak må sendes tilbake til avsender?",
  "Hvilke frister gjelder for å svare på en ekstern henvendelse?",
  "Hvordan dokumenterer vi at et vedtak er formidlet?",
  "Hva gjør vi når to kilder oppgir motstridende opplysninger?",
  "Hvilken betydning har varigheten av oppdraget for vurderingen?",
  "Hvordan behandles saker der innsender er selvstendig næringsdrivende?",
  "Hva skjer med en løpende sak hvis kontaktpersonen byttes ut?",
  "Hvordan registreres et vedtak slik at det blir synlig for motparten?",
  "Hvilke vedlegg må ligge ved før en sak kan behandles?",
  "Hva er forskjellen på en midlertidig og en endelig avgjørelse?",
  "Hvordan følger vi opp en sak der motparten ikke svarer?",
  "Hvilke opplysninger kan vi dele med en ekstern part i en pågående sak?",
];

function loadQuestions(): string[] {
  const path = process.env.VERTEX_SMOKE_QUESTIONS?.trim();
  if (!path) return DEFAULT_QUESTIONS;
  let text: string;
  try {
    text = require("node:fs").readFileSync(path, "utf8") as string;
  } catch (err) {
    throw new Error(`VERTEX_SMOKE_QUESTIONS=${path}: ${(err as Error).message}`);
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new Error(`VERTEX_SMOKE_QUESTIONS=${path} has no questions (only blanks/comments)`);
  return lines;
}

// Resolved BEFORE any probe runs. A typo'd path used to abort the script after
// probe A had already spent its calls and printed, throwing away the result.
let QUESTIONS: string[];
try {
  QUESTIONS = loadQuestions();
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

const summary: Record<string, unknown> = { project: "<redacted>", generatedAt: new Date().toISOString() };

/**
 * Reasons this run did not actually MEASURE anything. A bogus project produced
 * ten `HTTP 400 … not found or deleted` rows and exited 0 — after which nothing
 * automated, and no reader skimming a log tail, could tell a measured result
 * from a measurement that never happened.
 */
const failures: string[] = [];

let token: string;
try {
  token = await accessToken();
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
say(`\nVertex smoke — project from VERTEX_PROJECT_ID (redacted in all output), ADC token acquired\n`);

const REACH_GLYPH: Record<string, string> = {
  "reachable": "✔ reachable", "no-quota": "◐ entitled, NO QUOTA (429)",
  "not-available": "✘ not available (404)", "denied": "✘ denied (403)", "transport-error": "? transport error",
};

if (RUN.has("regions")) {
  say("── Probe A: what this project can CALL, dialled (not the catalogue) ──");
  const rows = await probeRegions(token);
  summary.availability = rows;
  // Every host refusing the LISTING is not an availability finding, it is a
  // broken run — a bad project id, a disabled API, no network.
  if (rows.every((r) => Object.values(r.publishers).every((p) => p.listed === null))) {
    failures.push("probe A: every region refused the catalogue listing — nothing was measured");
  }
  for (const r of rows) {
    say(`\n  ${r.location}${r.note ? `  (${r.note})` : ""}`);
    for (const [publisher, p] of Object.entries(r.publishers)) {
      if (p.listed === null) { say(`    ${publisher.padEnd(9)} — HTTP ${p.status}: ${p.refusal?.slice(0, 130)}`); continue; }
      if (p.listed.length === 0) { say(`    ${publisher.padEnd(9)} catalogue lists none`); continue; }
      const skipped = p.listed.length - p.dialled.length;
      say(`    ${publisher.padEnd(9)} catalogue lists ${p.listed.length}, dialled ${p.dialled.length}` +
          `${skipped > 0 ? ` (${skipped} non-text model${skipped === 1 ? "" : "s"} not dialled)` : ""}:`);
      for (const d of p.dialled) {
        say(`      ${(REACH_GLYPH[d.reach] ?? d.reach).padEnd(27)} ${d.model}${d.retried ? "  (retried)" : ""}` +
            (d.detail && d.reach !== "not-available" ? `\n          ${d.detail.slice(0, 120)}` : ""));
      }
    }
  }
  say("");
}

if (RUN.has("gemini")) {
  say(`── Probe B: ${GEMINI_MODEL} @ ${GEMINI_REGION}, ${QUESTIONS.length} questions, 41 tools ──`);
  const rows = await probeGemini(token, QUESTIONS);
  summary.gemini = rows;
  for (const r of rows) {
    say(`  ${String(r.ms).padStart(5)}ms  ${r.outcome.padEnd(18)} ${r.calledTool ?? "(no tool)"}` +
        (r.error ? `\n           ${r.error}` : ""));
  }
  // The denominator is `enteredLoop`, not a sum over outcomes. Only a run that
  // actually called a tool can have a broken second turn, so a first-turn 404,
  // a direct answer and an empty first turn are all outside BOTH halves.
  const inLoop = rows.filter((r) => r.enteredLoop);
  const completed = inLoop.filter((r) => r.outcome === "loop-completed").length;
  const broken = inLoop.length - completed;
  const outside = rows.length - inLoop.length;
  // Derived from the OUTCOMES PRESENT, not from a hand-written tuple: a literal
  // list silently dropped any outcome missing from it — `truncated` among them —
  // from the breakdown while it still counted in `outside`, so the numbers on
  // the two lines stopped adding up with nothing to say why.
  const tally = (subset: GeminiTurn[]) => {
    const counts = new Map<TurnOutcome, number>();
    for (const r of subset) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
    return [...counts].map(([o, n]) => `${o} ${n}`).join(", ");
  };
  const count = (o: TurnOutcome) => rows.filter((r) => r.outcome === o).length;
  const outsideBreakdown = tally(rows.filter((r) => !r.enteredLoop));
  // The in-loop breakdown is named too: a second-turn 429 lands in `broken`, and
  // a bare "broken/truncated: 3" invited the reader to conclude the model fails
  // 15% of the time when the failure was HTTP.
  const brokenBreakdown = tally(inLoop.filter((r) => r.outcome !== "loop-completed"));
  const rate = inLoop.length > 0 ? Math.round((100 * broken) / inLoop.length) : null;
  say(
    `\n  loop entered: ${inLoop.length}/${rows.length}   completed: ${completed}   ` +
    `did not complete: ${broken}${brokenBreakdown ? ` — ${brokenBreakdown}` : ""}` +
    `\n  never entered the loop (excluded from BOTH halves): ${outside}${outsideBreakdown ? ` — ${outsideBreakdown}` : ""}` +
    `\n  failure rate over the loop runs: ${rate === null ? "n/a — the loop was never entered" : rate + "%"}`,
  );
  if (inLoop.length < rows.length / 2) {
    say("  ⚠ over half the questions never entered the loop — the rate above is a thin sample.");
  }
  summary.geminiVerdict = {
    total: rows.length, entered: inLoop.length, completed, broken, outside, failureRatePct: rate,
  };
  // Two ways this probe measures NOTHING, and one that looks like it and is not.
  //
  //   - every question failed BEFORE entering the loop. `enteredLoop` is what
  //     makes that precise: a second-turn 429 is an `error` too, and a run of
  //     twenty of those reported "loop entered: 20/20 … 100%" AND "nothing was
  //     measured" on the same screen — the rate is the finding there, not a
  //     broken run.
  //   - nothing entered the loop and OUR OWN token cap is why. A run that is
  //     100% `truncated` is this file's constant misconfigured, and it exited 0.
  //
  // The case that stays exit 0 is a run the model answered directly throughout:
  // "never selected the tool out of 41" is the single most decision-relevant
  // thing probe B can say, and exiting 1 on it dresses a finding up as breakage.
  if (rows.length > 0 && rows.every((r) => r.outcome === "error" && !r.enteredLoop)) {
    failures.push("probe B: every question failed before a reply — nothing was measured");
  } else if (inLoop.length === 0 && rows.some((r) => r.outcome === "truncated")) {
    failures.push(
      `probe B: no question entered the loop and ${count("truncated")} were truncated — ` +
      `ANSWER_MAX_TOKENS (${ANSWER_MAX_TOKENS}) is too small to measure anything`,
    );
  }
  say("");
}

if (RUN.has("claude-sdk")) {
  say(`── Probe C: Agent SDK → Vertex ${CLAUDE_REGION}/${CLAUDE_MODEL}, no Anthropic credential ──`);
  const probe = await probeClaudeSdk();
  summary.claudeSdk = probe;
  say(`  apiKeySource: ${probe.apiKeySource ?? "(never reported)"}   outcome: ${probe.outcome}   ${probe.ms}ms`);
  say(`  detail: ${probe.detail}`);
  say(
    probe.outcome === "completed" || probe.outcome === "reached-vertex"
      ? "\n  ⇒ ADC authenticated the SDK with no ANTHROPIC_API_KEY, and a request reached Vertex.\n" +
        "    assertHaveAuth() is the only muninn-side blocker.\n"
      : probe.outcome === "did-not-reach"
        ? "\n  ⇒ The request never left this machine. Says nothing about ADC — fix the endpoint and re-run.\n"
        : probe.outcome === "timeout"
          // Its own sentence: a timeout matched nothing because we STOPPED
          // LISTENING, which is a different fact from "matched neither pattern".
          ? `\n  ⇒ TIMED OUT after ${SDK_TIMEOUT_MS}ms with no result event. Undecided — the request may\n` +
            "    still have been in flight. Re-run, or raise SDK_TIMEOUT_MS.\n"
          : "\n  ⇒ UNDECIDED. The outcome matched neither a Vertex answer nor a transport failure;\n" +
            "    read `detail` above before concluding anything about the ADC path.\n",
  );
  if (probe.outcome === "timeout") failures.push("probe C: timed out with no result");
}

if (JSON_MODE) console.log(redact(JSON.stringify(summary, null, 2)));

if (failures.length > 0) {
  for (const f of failures) console.error(`FAILED — ${f}`);
  process.exit(1);
}
