import { getLog } from "./logging.ts";

const log = getLog("config");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n\n` +
      `  Create a .env file from the example:\n` +
      `    cp .env.example .env\n\n` +
      `  Then edit .env with your values.`,
    );
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

/**
 * An optional env var with NO default: trimmed once, blank ⇒ null.
 *
 * The point is the SINGLE read. A defaulted string paired with a separate
 * `<name>Configured` boolean derives two facts from two reads that can disagree:
 * `CLAUDE_USAGE_URL="   "` made the boolean true (a non-empty string) while the
 * URL fell back to the default. Null-when-unset says both things at once, and
 * the feature layer applies its own default — which is also the house idiom
 * (`src/sync/` derives `configured` at the feature layer, not on `Config`).
 */
function nullableEnv(name: string): string | null {
  const raw = (process.env[name] ?? "").trim();
  return raw === "" ? null : raw;
}

/**
 * Values already warned about, keyed `<var>=<value>` — the flags here are read at
 * CALL time (the readonly seam reads on every write), so a per-call warn would
 * flood the log. Keyed by value, not just name, so correcting one typo into
 * another still reports.
 */
const warnedEnvFlagValues = new Set<string>();

/** Test-only: forget the warn-once memory so a test can re-observe a warning. */
export function __resetEnvFlagWarningsForTest(): void {
  warnedEnvFlagValues.clear();
}

/** Spellings that mean "off" explicitly. Turning a flag OFF on purpose is not a
 *  misconfiguration, so these are recognized and silent — unlike `on`/`yes`,
 *  which ASK for ON and would silently get OFF (the failure the warn reports). */
const OFF_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Boolean env flag accepting `1` / `true` (case-insensitive, trimmed). Distinct
 * from the `=== "true"` idiom used below because the flags that use it are
 * documented as `NAME=1`.
 *
 * An unrecognized non-empty value stays OFF — a typo must not brick an instance —
 * but says so once. The failure this reports is silent-OFF:
 * `MUNINN_WIKI_READONLY=yes` reads as "this instance owns wiki writes", which is
 * precisely the misconfiguration the flag exists to prevent, arriving with no
 * signal at all. An explicit OFF spelling (`OFF_VALUES`) is therefore NOT that
 * failure and warns about nothing — warning on `MUNINN_WIKI_READONLY=0` teaches
 * the operator to ignore the one line that matters.
 */
export function optionalEnvFlag(name: string): boolean {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (OFF_VALUES.has(raw)) return false;
  if (raw !== "" && !warnedEnvFlagValues.has(`${name}=${raw}`)) {
    warnedEnvFlagValues.add(`${name}=${raw}`);
    log.warn(
      "Unrecognized value for {name}: \"{value}\" — treated as OFF (expected 1 or true)",
      { name, value: raw },
    );
  }
  return false;
}

/**
 * `MUNINN_WIKI_READONLY=1` — this instance must make NO programmatic wiki page
 * CONTENT writes. Exported as a function (not only a `loadConfig()` field)
 * because the enforcement seams live below the config layer and must not
 * require `DATABASE_URL`, which `loadConfig` demands.
 *
 * Deliberately narrow: it forbids page writes, NOT git. `commitWikiChange` stays
 * unguarded so the repo-sync loop on a readonly instance can still commit/push.
 */
export function wikiReadonlyFromEnv(): boolean {
  return optionalEnvFlag("MUNINN_WIKI_READONLY");
}

/**
 * `WIKI_READONLY_ROOTS` — the raw, comma-separated list of wiki ROOTS this
 * instance may only read (the per-wiki sibling of the instance flag above).
 *
 * A getter for the same reason `wikiReadonlyFromEnv` is one: the enforcement
 * seams sit below the config layer and must not need `DATABASE_URL`. Kept as the
 * RAW string — parsing (`~`-expansion, repo-root resolution, dedup) belongs to
 * `src/wiki/readonly.ts`, which owns the path dialect; this function's whole job
 * is to be the one place the variable is named, so a rename is a compile error
 * rather than a silently-unguarded root. Blank/whitespace-only ⇒ undefined, so
 * "configured" cannot be true while pointing nowhere.
 */
export function wikiReadonlyRootsFromEnv(): string | undefined {
  return process.env.WIKI_READONLY_ROOTS?.trim() || undefined;
}

/**
 * `MUNINN_ADMIN_IDENTS` — the comma-split allowlist `resolveRole` compares a
 * claim against. Trimmed, lowercased and de-duplicated once, here, because the
 * comparison is case-insensitive on BOTH sides: §4's `A123456` and §3's
 * lowercased `nav-a123456` are the same person, and a silent case mismatch
 * would resolve *nobody* to admin.
 *
 * A getter rather than a `loadConfig()` field for the same reason
 * `wikiReadonlyFromEnv` is one: `src/auth/mode.ts` runs its boot refusals before
 * anything else is initialised and must not require `DATABASE_URL`.
 */
export function adminIdentsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const seen = new Set<string>();
  for (const part of (env.MUNINN_ADMIN_IDENTS ?? "").split(",")) {
    const value = part.trim().toLowerCase();
    if (value !== "") seen.add(value);
  }
  return [...seen];
}

/**
 * `MUNINN_ALLOWED_ORIGINS` — the origin allowlist PR C's origin/CSRF check and
 * PR D's WebSocket upgrade check will read. Parsed and boot-asserted in this
 * PR; **nothing enforces it yet**, and that is stated here rather than left for
 * a reader to infer from its presence that requests are being checked.
 *
 * Normalised through `URL` so `https://Host:443/` and `https://host` compare
 * equal, and an unparseable entry is dropped with a warning instead of silently
 * matching nothing.
 *
 * `*` is REFUSED rather than honoured. A wildcard here would be the fail-OPEN
 * direction for a list whose only job is to fail closed; dropping it leaves the
 * list empty, which is a boot refusal in any authenticating mode — loud, at the
 * one moment somebody is watching.
 */
export function allowedOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const seen = new Set<string>();
  for (const part of (env.MUNINN_ALLOWED_ORIGINS ?? "").split(",")) {
    const raw = part.trim();
    if (raw === "") continue;
    if (raw === "*") {
      log.warn("MUNINN_ALLOWED_ORIGINS contains \"*\" — refused. A wildcard origin allowlist allows every site; the entry is dropped.");
      continue;
    }
    try {
      const origin = new URL(raw).origin;
      if (origin === "null") throw new Error("opaque origin");
      seen.add(origin.toLowerCase());
    } catch {
      log.warn("MUNINN_ALLOWED_ORIGINS entry {entry} is not a parseable origin — dropped", { entry: raw });
    }
  }
  return [...seen];
}

/** The scheduler switch, as its own function so the `/models` machine card can
 *  report it without constructing a full `Config`. */
export function schedulerEnabledFromEnv(): boolean {
  return optionalEnv("SCHEDULER_ENABLED", optionalEnv("GOAL_CHECK_ENABLED", "true")) === "true";
}

export function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Environment variable ${name} must be a valid integer, got: "${raw}"`);
  return parsed;
}

export function loadConfig() {
  const whisperModelPath = optionalEnv("WHISPER_MODEL_PATH", "./models/ggml-base.en.bin");
  return {
    dashboardPort: optionalEnvInt("DASHBOARD_PORT", 3010),
    claudeTimeoutMs: optionalEnvInt("CLAUDE_TIMEOUT_MS", 120000),
    claudeModel: optionalEnv("CLAUDE_MODEL", "sonnet"),
    databaseUrl: requireEnv("DATABASE_URL"),
    whisperModelPath,
    // TikTok summarizer transcription model. Falls back to the shared whisper
    // model so English-only bots keep working; set TIKTOK_WHISPER_MODEL_PATH to
    // a multilingual model (e.g. ggml-base.bin) without touching Telegram voice.
    tiktokWhisperModelPath: optionalEnv("TIKTOK_WHISPER_MODEL_PATH", whisperModelPath),
    schedulerIntervalMs: optionalEnvInt(
      "SCHEDULER_INTERVAL_MS",
      optionalEnvInt("GOAL_CHECK_INTERVAL_MS", 60000),
    ),
    schedulerEnabled: schedulerEnabledFromEnv(),
    // NB no `wikiReadonly` field here on purpose: every reader goes through
    // `isWikiReadonly()` (wiki/readonly.ts), which reads at CALL time and honors
    // the test override. A snapshot on `Config` had zero readers and could only
    // ever disagree with what the seams enforce.
    logDir: optionalEnv("LOG_DIR", "./logs"),
    knowledgeApiUrl: optionalEnv("KNOWLEDGE_API_URL", "http://localhost:8321"),
    // The claude-usage pipeline-ledger service (launchd, port 8787 on the mini).
    // NULL when unset, and that null IS the "configured?" answer the /models card
    // needs — it decides whether an unreachable service is an error worth showing
    // or simply a service this host was never meant to have. The default URL
    // lives with the feature (`CLAUDE_USAGE_DEFAULT_URL`, applied at the route),
    // so this layer never has to carry a second field that can contradict it.
    claudeUsageUrl: nullableEnv("CLAUDE_USAGE_URL"),
    knowledgeViewableCollections: optionalEnv("KNOWLEDGE_VIEWABLE_COLLECTIONS", "").split(",").map(s => s.trim()).filter(Boolean),
    yggdrasilMcpUrl: optionalEnv("YGGDRASIL_MCP_URL", "http://127.0.0.1:9130"),
    tracingEnabled: optionalEnv("TRACING_ENABLED", "true") === "true",
    tracingRetentionDays: optionalEnvInt("TRACING_RETENTION_DAYS", 7),
    tracingCaptureToolOutputs: optionalEnv("TRACING_CAPTURE_TOOL_OUTPUTS", "true") === "true",
    promptSnapshotsRetentionDays: optionalEnvInt("PROMPT_SNAPSHOTS_RETENTION_DAYS", 3),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
