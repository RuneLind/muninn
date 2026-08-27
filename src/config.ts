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

/** The env var name, so the boot refusal, the docs row and the test agree. */
export const PROFILE_ENV = "MUNINN_PROFILE";

/**
 * The serving profiles. `default` is today's muninn — every route registered,
 * every vertical present. `nais` is the pod: no wiki working trees, no
 * `yt-dlp`/`ffmpeg`, colleagues on the other side of the door.
 */
export const MUNINN_PROFILES = ["default", "nais"] as const;
export type MuninnProfile = (typeof MUNINN_PROFILES)[number];

/**
 * `MUNINN_PROFILE` — WHICH DEPLOYMENT this process is, parsed fail-closed.
 *
 * Unset ⇒ `default`, so nothing about a laptop or the mini changes. An
 * unrecognised value THROWS rather than degrading to `default`, for the same
 * reason `parseAuthMode` throws (`src/auth/mode.ts`) and the inverse of
 * `optionalEnvFlag`'s warn-and-stay-off rule: here the degrade direction is
 * "the full surface" — `MUNINN_PROFILE=NAIS-prod` silently serving the wiki,
 * gardener, plans and logs routes on a pod is exactly the misconfiguration the
 * variable exists to prevent, and it would arrive with no signal at all.
 *
 * A function rather than only a `Config` field for the reason
 * `wikiReadonlyFromEnv` is one: the two consumers below the config layer — the
 * route factory (`src/dashboard/routes.ts`, called from unit tests with a
 * hand-built `{} as Config`) and the Haiku router's CLI-fallback refusal
 * (`src/ai/haiku-direct.ts`, which takes no `Config` at all) — must not need
 * `DATABASE_URL`. This is the ONE parse; `loadConfig` calls it too, so the
 * field and the getter can never disagree.
 */
export function resolveProfile(env: Record<string, string | undefined> = process.env): MuninnProfile {
  const raw = (env[PROFILE_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return "default";
  if ((MUNINN_PROFILES as readonly string[]).includes(raw)) return raw as MuninnProfile;
  throw new Error(
    `${PROFILE_ENV}="${raw}" is not a known serving profile (expected one of: ${MUNINN_PROFILES.join(", ")}). ` +
    `Refusing to start: an unrecognised value must not silently degrade to "default", which would ` +
    `serve the filesystem-bound routes this profile exists to drop.`,
  );
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
 * `wikiReadonlyFromEnv` is one: the layer that enforces it sits below `Config`,
 * and a snapshot field that can disagree with what the seam reads is the failure
 * this file already documents above. (It is NOT that `mode.ts` must avoid
 * `DATABASE_URL` — `loadConfig()` runs first in `src/index.ts` and demands it.)
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
 * `MUNINN_ALLOWED_ORIGINS` — the origin allowlist. **Enforced** by
 * `src/auth/origin.ts` (every side-effecting request in an authenticating mode)
 * and by `src/auth/cors.ts` (which origin, if any, an
 * `Access-Control-Allow-Origin` names). NOT yet enforced on the `/chat/ws`
 * upgrade, which runs before `app.fetch` and is PR D's.
 *
 * The loopback origins at the configured `DASHBOARD_PORT` are accepted without
 * being listed; every other origin muninn is REACHED at — the tailnet name
 * `tailscale serve` publishes, a LAN address under `DASHBOARD_HOST=0.0.0.0`,
 * an extension — must be an entry here, spelled exactly as the browser sends
 * it (scheme included).
 *
 * Normalised through `normalizeOrigin` so `https://Host:443/` and `https://host`
 * compare equal, and an unparseable entry is dropped with a warning instead of
 * silently matching nothing.
 *
 * Browser-extension origins (`chrome-extension://<id>`, `moz-extension://<id>`)
 * are accepted, and they are the reason `normalizeOrigin` exists rather than a
 * bare `new URL(raw).origin`: `URL` answers the OPAQUE string `"null"` for
 * those schemes, so the four Chrome extensions in `extensions/` — which call the
 * capture verticals and the Jira research routes — could not be allowlisted at
 * all, and PR C's origin check would refuse every one of them on an
 * authenticating instance. See `src/auth/cors.ts` for the per-site disposition.
 *
 * `*` is REFUSED rather than honoured. A wildcard here would be the fail-OPEN
 * direction for a list whose only job is to fail closed; dropping it leaves the
 * list empty, which is a boot refusal in any authenticating mode — loud, at the
 * one moment somebody is watching.
 */
export const EXTENSION_ORIGIN_SCHEMES = ["chrome-extension:", "moz-extension:"] as const;

/**
 * One origin string → its canonical comparable form, or `null` when the value is
 * not an origin at all.
 *
 * Shared by the env parser below and by the request-time check in
 * `src/auth/origin.ts`, so an allowlist entry and an incoming `Origin` header
 * can never be normalised two different ways — the class of bug where a
 * configured origin silently matches nothing.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "*") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // `URL.origin` is the opaque string "null" for a non-special scheme, which
  // would collapse every extension id onto one another. Rebuild it from the
  // parts instead — for the two extension schemes ONLY, so no other opaque
  // scheme (`file:`, `data:`) sneaks in through the same door.
  if ((EXTENSION_ORIGIN_SCHEMES as readonly string[]).includes(url.protocol)) {
    if (url.host === "") return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  }
  const origin = url.origin;
  if (origin === "null") return null;
  return origin.toLowerCase();
}

export function allowedOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const seen = new Set<string>();
  for (const part of (env.MUNINN_ALLOWED_ORIGINS ?? "").split(",")) {
    const raw = part.trim();
    if (raw === "") continue;
    if (raw === "*") {
      log.warn("MUNINN_ALLOWED_ORIGINS contains \"*\" — refused. A wildcard origin allowlist allows every site; the entry is dropped.");
      continue;
    }
    const origin = normalizeOrigin(raw);
    if (origin) seen.add(origin);
    else log.warn("MUNINN_ALLOWED_ORIGINS entry {entry} is not a parseable origin — dropped", { entry: raw });
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
    // WHICH deployment this is. Read through `resolveProfile()` — the same
    // parse the route factory and the Haiku router use, so a field here can
    // never disagree with what those seams enforce.
    profile: resolveProfile(),
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
