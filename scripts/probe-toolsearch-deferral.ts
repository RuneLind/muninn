/**
 * Probe: how reliably does the email watcher's spawn resolve its DEFERRED Gmail
 * tools through ToolSearch?
 *
 * The email checker's failure mode is silent: every way it can break — Gmail MCP
 * down, permissions denied, the model never calling the tool — arrives as `[]`,
 * which is also its modal CORRECT output ("no important email today"). muninn #434
 * added a liveness predicate for that and #436 a bounded retry keyed on it; this
 * probe is how you measure the rate they are up against, or test a candidate fix,
 * WITHOUT waiting hours for organic hourly ticks.
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
 * ⚠️ **THOSE NUMBERS ARE NOT REPRODUCIBLE BY THIS VERSION, AND THAT IS THE POINT.**
 * They were measured at a 90s timeout, with a killed run scored `CLEAN`, and with
 * "reached Gmail" read from a tool NAME. This build kills at production's 60s, scores
 * a killed run `TIMEOUT`, and checks the tool RESULT — so the same population scores
 * materially worse here. Do not diff a fresh run against 12.5% and read the
 * difference as a regression; re-baseline first.
 *
 * ⚠️ **`CLEAN` IS FLOOR-LIMITED BY THE 60s BUDGET.** A run that resolves on the first
 * ToolSearch and calls Gmail still scores `TIMEOUT` if it exceeds the budget, and real
 * runs measured 60.8s during this rewrite. A low `CLEAN` count is therefore not
 * automatically a deferral finding — read "never called Gmail" for that, and
 * "reached Gmail but timed out" for the budget.
 *
 * ⚠️ **A RUN IS ONE SPAWN, NOT ONE TICK.** Since #436 a production check spawns up
 * to twice, so a tick fails only when both spawns do. Read these numbers as the
 * per-spawn rate the retry is sized against; the tick rate is roughly its square.
 *
 * FIDELITY. The argv comes from muninn's own `buildHaikuArgs` and the prompt from
 * its own `buildEmailPrompt`, fed by default from the LIVE `email` watcher row
 * (filter, criteria, model) plus its owner's interest profile — the three things a
 * copy silently drifts from. `PROBE_NO_DB=1` falls back to the shipped defaults and
 * says so. The per-attempt timeout is imported from `HAIKU_TIMEOUT_MS`, so a run
 * this probe scores as slow-but-fine cannot be one production would have killed.
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
import { existsSync } from "node:fs";
import { buildHaikuArgs, HAIKU_TIMEOUT_MS, DEFAULT_MODEL } from "../src/scheduler/executor.ts";
import { DEFAULT_EMAIL_PROMPT, buildGmailQuery, buildEmailPrompt } from "../src/watchers/email.ts";
import { resolveAgentCwd } from "../src/ai/agent-cwd.ts";

const REPO = resolve(__dirname, "..");

/** Positive integer or bust — `N=abc` used to print a confident `CLEAN 0/0`. */
const MAX_N = 100;
function intEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  // Decimal digits only. `Number.isInteger` alone accepts `1e3`, and every run is a
  // real Haiku spawn plus a real Gmail search — a fat-fingered `N=1e2` is a far more
  // expensive typo than the `N=abc` the guard was written for.
  if (!/^\d+$/.test(raw.trim())) {
    console.error(`[probe] ${name}="${raw}" is not a plain positive integer`);
    process.exit(1);
  }
  const n = Number(raw);
  if (n < 1 || n > max) {
    console.error(`[probe] ${name}=${n} out of range (1..${max}) — each run is a real spawn and a real Gmail search`);
    process.exit(1);
  }
  return n;
}
const N = intEnv("N", 12, MAX_N);

/**
 * The per-attempt budget production actually enforces. Imported, not copied: at the
 * old hardcoded 90s every run lasting 60–90s scored as a success while a real tick
 * would have been killed and counted a failure, so the headline rate was a lower
 * bound dressed as an estimate.
 */
const RUN_TIMEOUT_MS = HAIKU_TIMEOUT_MS;
/** Grace after SIGTERM before SIGKILL — a child ignoring TERM used to hang the probe. */
const KILL_GRACE_MS = 5_000;

/** `label=binary` pairs. Default: whatever `claude` resolves to on PATH. */
const ARMS: Array<{ label: string; bin: string }> = (process.env.PROBE_ARMS
  ? process.env.PROBE_ARMS.split(",")
  : ["current=claude"]
).map((entry) => {
  const trimmed = entry.trim();
  // split on the FIRST `=` only — a binary path may contain one, and slicing it
  // off silently pointed the arm at a path that doesn't exist.
  const eq = trimmed.indexOf("=");
  const label = eq > 0 ? trimmed.slice(0, eq).trim() : "";
  const bin = eq > 0 ? trimmed.slice(eq + 1).trim() : "";
  if (!label || !bin) throw new Error(`bad PROBE_ARMS entry: "${entry}" (want label=binary)`);
  return { label, bin };
});
{
  const seen = new Set<string>();
  for (const { label } of ARMS) {
    if (seen.has(label)) throw new Error(`duplicate PROBE_ARMS label "${label}" — two binaries would merge into one row`);
    seen.add(label);
  }
}

/**
 * Arms run PAIRED, so a batch is one run of each. With a single arm that means
 * concurrency 1 — production runs one spawn at a time, and doubling the load for
 * no comparative benefit skews the durations the study reads.
 */
const CONCURRENCY = ARMS.length;

/**
 * The live watcher row's own inputs. A hardcoded filter/prompt/model matches
 * production only until someone edits the row, after which the probe keeps
 * measuring the old shape while claiming to track the current one.
 */
async function loadLiveTask(): Promise<{
  query: string;
  prompt: string;
  model: string;
  botDir: string;
  source: string;
}> {
  const fallback = () => ({
    query: buildGmailQuery(undefined, Date.now()),
    prompt: buildEmailPrompt(buildGmailQuery(undefined, Date.now()), DEFAULT_EMAIL_PROMPT, null),
    model: DEFAULT_MODEL,
    botDir: resolve(REPO, "bots/jarvis"),
    source: "shipped defaults (no DB)",
  });
  if (process.env.PROBE_NO_DB === "1") return fallback();
  try {
    const { initDb } = await import("../src/db/client.ts");
    const { loadConfig } = await import("../src/config.ts");
    // A script gets no `src/index.ts` bootstrap, so the pool is opened here.
    const sql = initDb(loadConfig());
    const [row] = await sql`
      SELECT id, user_id, bot_name, config, last_run_at FROM watchers
      WHERE type = 'email' AND enabled = true ORDER BY created_at LIMIT 1
    `;
    if (!row) return fallback();
    const config = (row.config ?? {}) as { filter?: string; prompt?: string; model?: string };
    // The row's OWN `last_run_at`, not `Date.now()`. `buildGmailQuery` takes it, and
    // two production shapes are unreachable from a synthetic clock: a null
    // `last_run_at` (first run after a row is created or reset) omits `after:`
    // entirely and searches the whole unread mailbox, and a stale one after downtime
    // spans days. Those are the largest-context, most timeout-prone runs there are —
    // exactly the population this probe most needs to be able to produce.
    const lastRunAt = row.last_run_at ? new Date(row.last_run_at as string).getTime() : null;
    const query = buildGmailQuery(config.filter, lastRunAt);
    const { loadInterestProfile } = await import("../src/profile/generator.ts");
    const profile = await loadInterestProfile(row.user_id as string, row.bot_name as string);
    // The bot dir must follow the ROW, not a hardcoded `bots/jarvis`: `--mcp-config`
    // and `--settings` come from it, so a row belonging to another bot would send
    // that bot's criteria through this one's mailbox and permission set — and be
    // reported as the production shape.
    const botDir = resolve(REPO, "bots", String(row.bot_name));
    if (!existsSync(botDir)) {
      console.error(`[probe] watcher row belongs to bot "${row.bot_name}" but ${botDir} does not exist`);
      process.exit(1);
    }
    return {
      query,
      prompt: buildEmailPrompt(query, config.prompt || DEFAULT_EMAIL_PROMPT, profile),
      model: config.model || DEFAULT_MODEL,
      botDir,
      source: `live watcher row (${row.bot_name}${profile ? ", +interest profile" : ", no profile"}, after: from last_run_at)`,
    };
  } catch (err) {
    console.error(`[probe] could not read the live watcher row (${err instanceof Error ? err.message : String(err)}) — using shipped defaults`);
    return fallback();
  }
}

const TASK = await loadLiveTask();
// postgres.js keeps its pool alive for ~20s after the last query, so without this the
// summary prints and the process then sits silent — indistinguishable from a hang,
// and instant on an all-CRASH run where nothing else takes time.
if (process.env.PROBE_NO_DB !== "1") {
  try {
    const { getDb } = await import("../src/db/client.ts");
    await getDb().end({ timeout: 5 });
  } catch { /* never initialised — nothing to close */ }
}

/**
 * `CRASH` and `TIMEOUT` exist so the deferral buckets mean what they say.
 *
 * A run the probe KILLED used to be classified from its partial stream — and a
 * killed run that had got one Gmail call out landed as `CLEAN`, the best label
 * available, while counting toward "reached Gmail". That is exactly the class
 * #436's commit message describes (a run that loops long enough to hit the
 * timeout instead of answering `[]`), so the study was blind to it by
 * construction. Likewise a spawn that exits non-zero with no tools — an OAuth
 * expiry, a rate-limit exit, a failed `npx` MCP launch — is not evidence about
 * ToolSearch, and counting it as `NOTOOL` inflated the headline rate.
 */
type Outcome = "CLEAN" | "SLOW" | "LOOP" | "BASH" | "NOTOOL" | "OTHER" | "TIMEOUT" | "CRASH";

interface Run {
  arm: string;
  i: number;
  outcome: Outcome;
  /** Called a Gmail tool AND that call did not come back an error. */
  reachedGmail: boolean;
  /** Called a Gmail tool that returned `is_error` (denied / MCP failure). */
  gmailError: boolean;
  toolSearches: number;
  tools: string[];
  exitCode: number | null;
  ms: number;
  note?: string;
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
 * silently reports an empty inbox. It is also #434's predicate, so it inherits that
 * predicate's blind spot — hence `gmailError`, reported beside it.
 *
 * `LOOP` and `BASH` are not exclusive in reality (a run can do both); BASH wins,
 * and `toolSearches` carries the loop length for every bucket, so the ToolSearch
 * retry distribution is readable without the buckets pretending to partition it.
 */
function classify(tools: string[], gmail: boolean): Outcome {
  const bash = tools.some((t) => t.toLowerCase() === "bash");
  const ts = tools.filter((t) => t === "ToolSearch").length;
  if (tools.length === 0) return "NOTOOL";
  if (gmail && !bash && ts <= 1) return "CLEAN";
  if (bash) return "BASH";
  if (gmail) return "SLOW";
  if (ts > 1) return "LOOP";
  // Exactly one ToolSearch and nothing else: it resolved (or failed to) and then gave
  // up without calling anything. That is a DIFFERENT population from "called literally
  // nothing", which is what NOTOOL means — the first cut of this bucket conflated them
  // right after adding OTHER to stop exactly that.
  return "OTHER";
}

async function once(arm: string, bin: string, i: number): Promise<Run> {
  const t0 = performance.now();
  const base: Omit<Run, "outcome" | "reachedGmail" | "gmailError" | "toolSearches" | "tools" | "exitCode" | "ms"> =
    { arm, i };
  try {
    const args = buildHaikuArgs({
      prompt: TASK.prompt,
      model: TASK.model,
      botDir: TASK.botDir,
    });
    // The arm swap assumes the binary is argv[0]. Assert it rather than trusting
    // it: if a wrapper is ever prepended, a silent overwrite of a FLAG would make
    // the arms stop meaning what they say with no error anywhere.
    if (args[0] !== "claude") throw new Error(`buildHaikuArgs no longer starts with "claude" (got "${args[0]}") — the arm swap would clobber a flag`);
    args[0] = bin;

    const proc = Bun.spawn(args, {
      // The same helper production uses, so the agent home — the one variable this
      // study's conclusion actually names — is resolved the same way, honors
      // MUNINN_AGENT_CWD, and is created if absent. A sibling bucket, not jarvis's,
      // so probe transcripts stay separable from real ticks.
      cwd: resolveAgentCwd("probe"),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "probe-toolsearch-deferral" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    let killed = false;
    let sigkill: ReturnType<typeof setTimeout> | undefined;
    const killer = setTimeout(() => {
      // A run whose streams have already closed must not be labelled TIMEOUT just
      // because the two awaits below were slow to settle — that fails in the
      // direction that inflates the headline rate.
      if (proc.exitCode !== null) return;
      killed = true;
      proc.kill();
      // A child that ignores SIGTERM (or a grandchild holding the stdout pipe)
      // would otherwise hang the whole probe on the `await` below.
      sigkill = setTimeout(() => { try { proc.kill(9); } catch { /* already gone */ } }, KILL_GRACE_MS);
    }, RUN_TIMEOUT_MS);
    // stderr is drained CONCURRENTLY — `executor.ts` does the same and says why:
    // an undrained pipe fills at ~64KB and blocks the child while we read stdout.
    const [out, errText] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(killer);
    // Left pending, this fires `kill(9)` on a reaped pid AND holds the event loop
    // open — measured 4s of dead time after every killed run.
    if (sigkill) clearTimeout(sigkill);

    const tools: string[] = [];
    /** tool_use id → name, so a `tool_result` can be attributed to its call. */
    const byId = new Map<string, string>();
    const erroredIds = new Set<string>();
    for (const line of out.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const msg = JSON.parse(line)?.message;
        for (const c of msg?.content ?? []) {
          if (c?.type === "tool_use" && c.name) {
            tools.push(String(c.name));
            if (c.id) byId.set(String(c.id), String(c.name));
          }
          // A denied or failed Gmail call is not "reached Gmail" in any sense the
          // watcher cares about — and #434's production predicate cannot see it,
          // which is precisely why the instrument must.
          if (c?.type === "tool_result" && c.is_error && c.tool_use_id) erroredIds.add(String(c.tool_use_id));
        }
      } catch {
        // Non-JSON / partial lines are expected on a killed run.
      }
    }
    const gmailCalls = [...byId.entries()].filter(([, name]) => name.startsWith("mcp__gmail__"));
    const gmailOk = gmailCalls.some(([id]) => !erroredIds.has(id));
    const gmailErrored = gmailCalls.some(([id]) => erroredIds.has(id));
    // Fallback for a Gmail call whose stream carried no usable id: treat presence
    // as reached, since the alternative is under-counting the healthy case.
    const gmailByName = tools.some((t) => t.startsWith("mcp__gmail__"));

    const ms = Math.round(performance.now() - t0);
    const reached = gmailCalls.length > 0 ? gmailOk : gmailByName;
    if (killed) {
      // `reachedGmail` is REAL here, not false. Hardcoding false made a run that
      // resolved the deferred tool on its first try, called `search_emails`, and then
      // exceeded the budget count as "never reached Gmail" — folding the budget
      // failure into the deferral rate under the deferral rate's name. They are
      // different mechanisms with different fixes; the summary now reports both.
      return { ...base, outcome: "TIMEOUT", reachedGmail: reached, gmailError: gmailErrored, toolSearches: tools.filter((t) => t === "ToolSearch").length, tools, exitCode, ms, note: `killed at ${RUN_TIMEOUT_MS}ms` };
    }
    // A non-zero exit says nothing about ToolSearch — but only the tool-less case was
    // caught. A rate-limit exit or an OAuth expiry AFTER two ToolSearch calls landed
    // in LOOP/OTHER and counted in the deferral denominator, which is the inflation
    // this bucket exists to remove.
    if (exitCode !== 0 && !reached) {
      return { ...base, outcome: "CRASH", reachedGmail: false, gmailError: gmailErrored, toolSearches: tools.filter((t) => t === "ToolSearch").length, tools, exitCode, ms, note: errText.trim().split("\n").pop()?.slice(0, 120) || `exit ${exitCode}` };
    }
    return {
      ...base,
      outcome: classify(tools, reached),
      reachedGmail: reached,
      gmailError: gmailErrored,
      toolSearches: tools.filter((t) => t === "ToolSearch").length,
      tools,
      exitCode,
      ms,
    };
  } catch (err) {
    // A spawn that throws (bad PROBE_ARMS path, unwritable cwd) used to abort
    // Promise.all and destroy the whole batch's summary AFTER the other runs had
    // already been paid for.
    return { ...base, outcome: "CRASH", reachedGmail: false, gmailError: false, toolSearches: 0, tools: [], exitCode: null, ms: Math.round(performance.now() - t0), note: err instanceof Error ? err.message : String(err) };
  }
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
console.log(`[probe] N=${N} per arm, timeout ${RUN_TIMEOUT_MS}ms (production per-attempt), model ${TASK.model}`);
console.log(`[probe] task: ${TASK.source}, query: ${TASK.query}`);
console.log(`[probe] prompt: ${TASK.prompt.length} chars\n`);

const results: Run[] = [];
for (let k = 0; k < jobs.length; k += CONCURRENCY) {
  const done = await Promise.all(
    jobs.slice(k, k + CONCURRENCY).map((j) => once(j.arm, j.bin, j.i)),
  );
  for (const r of done) {
    results.push(r);
    console.log(
      `${r.arm.padEnd(10)} #${String(r.i).padStart(2)}  ${r.outcome.padEnd(7)} ` +
        `ts=${String(r.toolSearches).padStart(2)} ${String(r.ms).padStart(6)}ms  ` +
        // exit code shown whenever it is not a clean 0 — it was recorded and then
        // never printed, so a non-zero exit was invisible on every row.
        `${r.exitCode ? `exit=${r.exitCode} ` : ""}` +
        `${r.tools.join(",") || "-"}${r.gmailError ? "  [gmail tool_result is_error]" : ""}` +
        `${r.note ? `  (${r.note})` : ""}`,
    );
  }
}

console.log("\n===== SUMMARY =====");
for (const { label } of ARMS) {
  const rs = results.filter((r) => r.arm === label);
  const c = (o: Outcome) => rs.filter((r) => r.outcome === o).length;
  // Runs that say something about DEFERRAL. A crash says nothing about it, so it
  // is reported separately rather than diluting (or inflating) the rate.
  const measurable = rs.filter((r) => r.outcome !== "CRASH");
  // THE TWO MECHANISMS, REPORTED SEPARATELY. "Never called Gmail" is deferral —
  // the thing this probe exists to measure. "Timed out having called Gmail" is the
  // budget, which #436's retry addresses for a different reason. One number covering
  // both is how a 60s budget problem gets read as a deferral regression.
  const neverCalled = measurable.filter((r) => !r.reachedGmail).length;
  const timedOutReached = rs.filter((r) => r.outcome === "TIMEOUT" && r.reachedGmail).length;
  console.log(
    `${label}: CLEAN ${c("CLEAN")}/${measurable.length}  SLOW ${c("SLOW")}  LOOP ${c("LOOP")}  ` +
      `BASH ${c("BASH")}  NOTOOL ${c("NOTOOL")}  OTHER ${c("OTHER")}  TIMEOUT ${c("TIMEOUT")}` +
      `  |  never called Gmail: ${neverCalled}/${measurable.length}` +
      (timedOutReached ? `  |  reached Gmail but timed out: ${timedOutReached}` : "") +
      (c("CRASH") ? `  |  CRASH ${c("CRASH")} (excluded)` : "") +
      (rs.some((r) => r.gmailError) ? `  |  gmail tool errors: ${rs.filter((r) => r.gmailError).length}` : ""),
  );
  // Timeouts are CENSORED at the budget, so folding them into a median reports the
  // timeout back as if it were a measurement. Finished runs first, then the count.
  const finished = measurable.filter((r) => r.outcome !== "TIMEOUT").map((r) => r.ms).sort((a, b) => a - b);
  if (finished.length) {
    console.log(`${" ".repeat(label.length + 2)}durations (finished runs): min ${finished[0]}ms  median ${finished[Math.floor(finished.length / 2)]}ms  max ${finished[finished.length - 1]}ms` +
      (c("TIMEOUT") ? `  (+${c("TIMEOUT")} censored at ${RUN_TIMEOUT_MS}ms)` : ""));
  } else if (c("TIMEOUT")) {
    console.log(`${" ".repeat(label.length + 2)}durations: every run hit the ${RUN_TIMEOUT_MS}ms budget — no finished-run distribution to report`);
  }
}
