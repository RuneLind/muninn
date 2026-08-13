/**
 * Probe: how reliably does the email watcher's spawn resolve its DEFERRED Gmail
 * tools through ToolSearch?
 *
 * The email checker's failure mode is silent: every way it can break — Gmail MCP
 * down, permissions denied, the model never calling the tool — arrives as `[]`,
 * which is also its modal CORRECT output ("no important email today"). muninn #434
 * added a liveness predicate for that, and this probe is how you measure the rate
 * the predicate is up against, or test a candidate fix, WITHOUT waiting hours for
 * organic hourly ticks.
 *
 * Measured 2026-08-13 (96 runs): the Gmail tools are deferred, so 95 of 96 runs had
 * to resolve `mcp__gmail__search_emails` through a ToolSearch round-trip first. When
 * that round-trip fails it returns `[{"type":"tool_reference",...}]` and the tool
 * never becomes callable; the model then retries ToolSearch (up to 12x observed) or
 * improvises with Bash, and answers `[]`. On the production argv shape, 7/56 runs
 * (12.5%) never reached Gmail at all. Neither the CLI version (2.1.228 vs 2.1.231)
 * nor #431's argv shape moved that rate; `--allowed-tools` and pruning --mcp-config
 * to gmail-only were also measured and rejected — deferral tracks the BUILT-IN tool
 * surface in the agent home, not the MCP server count.
 *
 * Uses muninn's own `buildHaikuArgs` + `DEFAULT_EMAIL_PROMPT` + `buildGmailQuery`, so
 * the argv and prompt track production instead of drifting from a copy.
 *
 * Run:
 *   bun run scripts/probe-toolsearch-deferral.ts
 *   N=16 bun run scripts/probe-toolsearch-deferral.ts
 *   # A/B two binaries (e.g. a pinned CLI against the installed one):
 *   PROBE_ARMS="installed=claude,pinned=/tmp/cli228/node_modules/.bin/claude" \
 *     N=16 bun run scripts/probe-toolsearch-deferral.ts
 *
 * NB: every run performs a REAL Gmail search against the configured account. It is
 * read-only, but it is not free — N=16 across two arms is 32 Haiku spawns.
 */
import { resolve } from "node:path";
import { buildHaikuArgs } from "../src/scheduler/executor.ts";
import { DEFAULT_EMAIL_PROMPT, buildGmailQuery } from "../src/watchers/email.ts";

const REPO = resolve(__dirname, "..");
const BOT_DIR = resolve(REPO, "bots/jarvis");
const N = Number(process.env.N ?? 12);
/** Two at a time keeps the box responsive; the arms are paired inside each batch. */
const CONCURRENCY = 2;
const RUN_TIMEOUT_MS = 90_000;

/** `label=binary` pairs. Default: whatever `claude` resolves to on PATH. */
const ARMS: Array<{ label: string; bin: string }> = (process.env.PROBE_ARMS
  ? process.env.PROBE_ARMS.split(",")
  : ["current=claude"]
).map((entry) => {
  const [label, bin] = entry.split("=");
  if (!label || !bin) throw new Error(`bad PROBE_ARMS entry: "${entry}" (want label=binary)`);
  return { label, bin };
});

// The live watcher's own query shape (filter from its config; `after:` = today in
// Oslo), so the probe asks Gmail for the same thing a real tick would.
const QUERY = buildGmailQuery("-from:teamer.net", Date.now());

// The production prompt from src/watchers/email.ts. Deliberately NOT augmented with
// "you must call the tool" — that instruction biases the very behaviour under test.
// (The interest-profile block production appends is omitted: it changes prompt
// length, not the tool surface that drives deferral.)
const PROMPT = `You have access to Gmail MCP tools.
Search for unread emails matching: "${QUERY}"

${DEFAULT_EMAIL_PROMPT}

CRITICAL:
- "id" MUST be the exact Gmail message ID from the API (e.g. "19abc123def"). Copy it verbatim.
- "sender" MUST be the exact From header value (e.g. "Posten Norge")
- "subject" MUST be the exact email subject line, verbatim — do NOT rephrase or shorten it.

Return ONLY a JSON array (no markdown fences):
[{"id":"msg_id","source":"email","sender":"exact sender","subject":"exact subject","summary":"**Fra:** sender — subject brief","urgency":"high|medium|low"}]
If nothing worth notifying, return: []`;

type Outcome = "CLEAN" | "SLOW" | "LOOP" | "BASH" | "NOTOOL";

interface Run {
  arm: string;
  i: number;
  outcome: Outcome;
  reachedGmail: boolean;
  toolSearches: number;
  tools: string[];
  ms: number;
}

/**
 * CLEAN is deliberately STRICT: the deferred tool resolved on the FIRST ToolSearch
 * and was then called, with no shell improvisation. Counting "reached Gmail
 * eventually" as healthy scores a run that needed seven ToolSearch attempts as
 * clean and hides the effect being measured — that generosity is exactly what made
 * the first cut of this probe read 7/8 where the strict metric read 3/8.
 *
 * `reachedGmail` is tracked separately because it is the decision-relevant number
 * for the watcher's correctness: a run that never reached Gmail is a tick that
 * silently reports an empty inbox.
 */
function classify(tools: string[]): Outcome {
  const gmail = tools.some((t) => t.startsWith("mcp__gmail__"));
  const bash = tools.some((t) => t.toLowerCase() === "bash");
  const ts = tools.filter((t) => t === "ToolSearch").length;
  if (tools.length === 0) return "NOTOOL";
  if (gmail && !bash && ts <= 1) return "CLEAN";
  if (bash) return "BASH";
  if (gmail) return "SLOW";
  return ts > 1 ? "LOOP" : "NOTOOL";
}

async function once(arm: string, bin: string, i: number): Promise<Run> {
  const args = buildHaikuArgs({
    prompt: PROMPT,
    model: "claude-haiku-4-5-20251001",
    botDir: BOT_DIR,
  });
  args[0] = bin; // the ONLY difference between arms

  const t0 = performance.now();
  const proc = Bun.spawn(args, {
    cwd: `${process.env.HOME}/.muninn/agent-cwd/probe`,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "probe-toolsearch-deferral" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const killer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text().catch(() => "");
  await proc.exited;
  clearTimeout(killer);

  const tools: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      for (const c of JSON.parse(line)?.message?.content ?? []) {
        if (c?.type === "tool_use" && c.name) tools.push(String(c.name));
      }
    } catch {
      // Non-JSON / partial lines are expected on a killed run.
    }
  }

  return {
    arm,
    i,
    outcome: classify(tools),
    reachedGmail: tools.some((t) => t.startsWith("mcp__gmail__")),
    toolSearches: tools.filter((t) => t === "ToolSearch").length,
    tools,
    ms: Math.round(performance.now() - t0),
  };
}

// INTERLEAVE the arms. Running arm-by-arm confounds the arm with time: this failure
// drifts hard run-to-run (an identical arm measured 3/8 and then 7/8 twenty minutes
// apart — larger than any between-arm difference observed), so whichever arm runs
// first inherits that window's luck. Pairing them inside a batch cancels the drift.
const jobs: Array<{ arm: string; bin: string; i: number }> = [];
for (let i = 1; i <= N; i++) {
  for (const { label, bin } of ARMS) jobs.push({ arm: label, bin, i });
}

console.log(`[probe] arms: ${ARMS.map((a) => `${a.label} (${a.bin})`).join(", ")}`);
console.log(`[probe] N=${N} per arm, query: ${QUERY}\n`);

const results: Run[] = [];
for (let k = 0; k < jobs.length; k += CONCURRENCY) {
  const done = await Promise.all(
    jobs.slice(k, k + CONCURRENCY).map((j) => once(j.arm, j.bin, j.i)),
  );
  for (const r of done) {
    results.push(r);
    console.log(
      `${r.arm.padEnd(10)} #${String(r.i).padStart(2)}  ${r.outcome.padEnd(6)} ` +
        `ts=${String(r.toolSearches).padStart(2)} ${String(r.ms).padStart(6)}ms  ` +
        `${r.tools.join(",") || "-"}`,
    );
  }
}

console.log("\n===== SUMMARY =====");
for (const { label } of ARMS) {
  const rs = results.filter((r) => r.arm === label);
  const c = (o: Outcome) => rs.filter((r) => r.outcome === o).length;
  const never = rs.filter((r) => !r.reachedGmail).length;
  console.log(
    `${label}: CLEAN ${c("CLEAN")}/${rs.length}  SLOW ${c("SLOW")}  LOOP ${c("LOOP")}  ` +
      `BASH ${c("BASH")}  NOTOOL ${c("NOTOOL")}  |  never reached Gmail: ${never}/${rs.length}`,
  );
}
