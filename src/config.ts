import { getLog } from "./logging.ts";

const log = getLog("config");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigError(
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

/** The env var name, so the boot refusal and the message below agree. Not
 *  exported: this file is the only parser, and `src/test/ambient-env.ts` spells
 *  the name itself rather than importing the config layer into a test preload. */
/**
 * A DELIBERATE fail-closed config refusal, as opposed to a bug in the config
 * layer. The distinction is what `src/index.ts` prints: a refusal is one legible
 * line (its message IS the whole diagnosis, and in a container a stack reaches
 * the log aggregator as an unhandled exception), while a `TypeError` from a bug
 * in here must keep its stack or nobody can find it. Same shape as
 * `AuthConfigError` in `src/auth/mode.ts`.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const PROFILE_ENV = "MUNINN_PROFILE";

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
 * A function as well as a `Config` field, for the reason `wikiReadonlyFromEnv`
 * is one: the consumers below the config layer — the Haiku router's CLI refusal
 * (`src/ai/haiku-cli-unavailable.ts`) and `renderNav` — take no `Config` at all
 * and must not need `DATABASE_URL`, which `loadConfig` demands. **The pair is
 * the rule: a `Config` field where a `Config` exists, this getter where none
 * does, one parse either way** — `loadConfig` calls it too, so the field and the
 * getter can never disagree.
 *
 * Named `resolveServingProfile`, not `resolveProfile`: `src/research/corpus.ts`
 * already exports a `resolveProfile` (the research CORPUS profile), and two
 * same-named exports one import away from each other is how the wrong one gets
 * auto-imported.
 */
export function resolveServingProfile(env: Record<string, string | undefined> = process.env): MuninnProfile {
  const raw = (env[PROFILE_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return "default";
  if ((MUNINN_PROFILES as readonly string[]).includes(raw)) return raw as MuninnProfile;
  throw new ConfigError(
    `${PROFILE_ENV}="${raw}" is not a known serving profile (expected one of: ${MUNINN_PROFILES.join(", ")}). ` +
    `Refusing to start: an unrecognised value must not silently degrade to "default", which would ` +
    `serve the filesystem-bound routes this profile exists to drop.`,
  );
}

/**
 * The `global` Vertex region, spelled once.
 *
 * Some deployments are required to keep model inference inside a named
 * jurisdiction, and `global` is the one region that cannot satisfy that by
 * construction: Google routes it to whichever region has capacity and does not
 * report which. A platform may also block it, but muninn refuses it in its own
 * right — a guard that delegates to someone else's org policy stops working the
 * moment the process runs somewhere else, and "it happened to work when I
 * tested" is not evidence the region was permitted.
 */
const VERTEX_GLOBAL_REGION = "global";

/**
 * The region-less Vertex host, which IS the global endpoint — confirmed against
 * the bundled Agent SDK binary, which maps the region `global` to exactly this
 * origin. Refusing only the region NAME would be an inert guard:
 * `ANTHROPIC_VERTEX_BASE_URL` steers the SDK past every region variable, so
 * `global` walks in through a second door that never spells the word.
 *
 * The MULTI-REGION hosts (`aiplatform.eu.rep.googleapis.com` and its siblings)
 * are different hosts and are NOT refused: Google documents them as keeping
 * processing inside one jurisdiction, which is the opposite of what makes
 * `global` unusable. Whether a given deployment's policy accepts a multi-region
 * endpoint is that deployment's question, not this layer's to pre-empt.
 */
const VERTEX_GLOBAL_HOST = "aiplatform.googleapis.com";

/**
 * The SDK's PER-MODEL region overrides, by prefix rather than by list.
 *
 * ⚠️ This prefix is the whole reason the region guard is not inert. The bundled
 * CLI resolves a region as: find the first entry of its model→env map whose key
 * prefixes the model id, and if one matches, use `process.env[thatName]` —
 * **falling back to `CLOUD_ML_REGION` only when none does**. So
 * `VERTEX_REGION_CLAUDE_4_5_SONNET=global` BEATS `CLOUD_ML_REGION=europe-north1`
 * for every Sonnet 4.5 turn, and the resulting host is the global endpoint. A
 * guard on the two obvious names alone booted that config cleanly while
 * `/models` asserted `europe-north1`.
 *
 * Matched by PREFIX, not against the twelve names the installed binary happens
 * to carry (`…_3_5_HAIKU` through `…_4_7_OPUS`): that list grows with every
 * model, and a hard-coded copy would be silently short by one the first time it
 * did. Anthropic's own Vertex documentation steers operators to these variables
 * precisely because model availability differs by region — so on any deployment
 * pinned to a region that lacks the newest model, this is the LIKELY
 * misconfiguration, not an exotic one.
 */
const VERTEX_PER_MODEL_REGION_PREFIX = "VERTEX_REGION_CLAUDE_";

/**
 * `CLAUDE_CODE_USE_VERTEX` spellings the SDK accepts, copied from the bundled
 * binary (`["1","true","yes","on"].includes(value.toLowerCase())`).
 *
 * Deliberately NOT `optionalEnvFlag`, which accepts only `1`/`true` and treats
 * everything else as an explicit or accidental off. Inverting a DENYLIST here —
 * "anything that is not `0`/`false`/`no`/`off` is on" — is what made muninn and
 * the SDK disagree about `CLAUDE_CODE_USE_VERTEX=y`: muninn said Vertex,
 * `assertHaveAuth()` waived the credential requirement, and the SDK took the
 * first-party path with no credential at all, failing per turn with a cryptic
 * error instead of at boot with a clear one. An allowlist copied from the
 * consumer is the only parse that cannot diverge.
 */
const VERTEX_ON_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * What this process would do if a Vertex call were made right now.
 *
 * Seven-plus env names steer that, and only two of them are muninn's. Four
 * belong to the Agent SDK — `CLAUDE_CODE_USE_VERTEX`,
 * `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_BASE_URL`
 * — plus the open-ended `VERTEX_REGION_CLAUDE_*` family, and the SDK reads all
 * of them from `process.env` itself. A guard that looked only at muninn's own
 * `VERTEX_*` names would be inert exactly when it mattered, refusing nothing
 * while the SDK dialled `global`.
 */
export interface VertexConfig {
  /**
   * Will the Agent SDK take the Vertex path? This is `CLAUDE_CODE_USE_VERTEX`
   * and nothing else, parsed with the SDK's own allowlist, because that is the
   * switch the SDK itself reads. Muninn's `VERTEX_PROJECT_ID` is configuration,
   * not a switch: setting it must not silently move a bot onto Vertex.
   */
  enabled: boolean;
  projectId: string | null;
  /** Which name supplied `projectId` — rendered on `/models`. When Vertex is
   *  ENABLED this is always the SDK's name, because nothing else is accepted. */
  projectIdSource: "ANTHROPIC_VERTEX_PROJECT_ID" | "VERTEX_PROJECT_ID" | null;
  region: string | null;
  regionSource: "CLOUD_ML_REGION" | "VERTEX_REGION" | null;
  /** `ANTHROPIC_VERTEX_BASE_URL`, verbatim. Set for the EU multi-region
   *  endpoint, whose host is not `<region>-aiplatform.googleapis.com`. */
  baseUrl: string | null;
  /**
   * Every `VERTEX_REGION_CLAUDE_*` that is SET, name and value. Rendered on
   * `/models` because these BEAT `regionSource` for the models they name, and a
   * card that reported only `CLOUD_ML_REGION` was telling an operator their
   * traffic went somewhere it did not.
   */
  perModelRegions: { name: string; region: string }[];
}

/**
 * The Vertex credential seam — one parse, and the boot refusals that go with it.
 *
 * A function as well as a `Config` field, by the pair rule
 * {@link resolveServingProfile} states: `assertHaveAuth()` in the claude-sdk
 * connector takes no `Config` and must not need `DATABASE_URL`, which
 * `loadConfig` demands.
 *
 * THROWS on six misconfigurations, and the split between them is deliberate.
 *
 * **Unconditional — whether or not Vertex is enabled**, because a forbidden
 * value sitting in `.env` waiting for someone to flip the switch is the
 * `MUNINN_PROFILE` failure shape, a misconfiguration that arrives with no
 * signal at all:
 *   - a `global` region, in EITHER of the two region names OR in any
 *     `VERTEX_REGION_CLAUDE_*`;
 *   - a base URL on the global host, same rule, other door;
 *   - a base URL that is not a URL.
 *
 * **Only when enabled**, because only then are they wrong — and each names the
 * SDK's OWN variable, because muninn does not export its own names into the
 * SDK's and a value under the wrong name reaches nothing:
 *   - no `ANTHROPIC_VERTEX_PROJECT_ID`. `VERTEX_PROJECT_ID` does NOT satisfy
 *     this: the SDK never reads it, and with no project of its own it falls
 *     back to whatever project ADC defaults to — so the old rule booted a
 *     config that silently billed and routed somewhere else entirely.
 *   - no `CLOUD_ML_REGION`. A base URL does NOT satisfy this either: the SDK
 *     builds the resource path from the region regardless, and its default is
 *     **`us-east5`** — measured in the bundled binary. Accepting a base URL
 *     alone certified an EU-multi-region config whose every request said
 *     `locations/us-east5`.
 *   - muninn's name and the SDK's name both set and DISAGREEING, for either
 *     project or region. One of the two is dead config, and guessing which the
 *     operator meant is not this layer's job. Conditional on `enabled` because
 *     `CLOUD_ML_REGION` is a generic Google variable: unrelated tooling sets it,
 *     and a hard boot refusal on an instance that never touches Vertex is noise.
 */
export function resolveVertexConfig(env: Record<string, string | undefined> = process.env): VertexConfig {
  const read = (name: string): string | null => {
    const raw = (env[name] ?? "").trim();
    return raw === "" ? null : raw;
  };

  const refuseGlobalRegion = (name: string, value: string | null) => {
    if (value !== null && value.toLowerCase() === VERTEX_GLOBAL_REGION) {
      throw new ConfigError(
        `${name}="${value}" is refused: the \`global\` Vertex region routes to whichever ` +
        `region has capacity and does not report which, so it cannot satisfy a deployment ` +
        `that must keep inference inside a named jurisdiction. Name an explicit region ` +
        `(e.g. europe-north1), or a multi-region endpoint if your policy allows one.`,
      );
    }
  };

  const vertexRegion = read("VERTEX_REGION");
  const cloudMlRegion = read("CLOUD_ML_REGION");
  refuseGlobalRegion("VERTEX_REGION", vertexRegion);
  refuseGlobalRegion("CLOUD_ML_REGION", cloudMlRegion);

  const perModelRegions: { name: string; region: string }[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(VERTEX_PER_MODEL_REGION_PREFIX)) continue;
    const region = read(name);
    if (region === null) continue;
    refuseGlobalRegion(name, region);
    perModelRegions.push({ name, region });
  }

  const baseUrl = read("ANTHROPIC_VERTEX_BASE_URL");
  if (baseUrl !== null) {
    let host: string | null = null;
    try {
      // The trailing dot is stripped before comparing: `aiplatform.googleapis.com.`
      // is the same name in DNS, and a bare string compare would let it through.
      // (It does not resolve on Bun today — the TLS name check refuses it — but
      // that is the runtime's accident, not this guard's doing.)
      // `hostname`, not `host`: the latter keeps a non-default port, so
      // `https://aiplatform.googleapis.com:8443` compared unequal and walked
      // straight through the guard. Trailing dots are stripped because
      // `aiplatform.googleapis.com.` is the same name in DNS.
      host = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      throw new ConfigError(`ANTHROPIC_VERTEX_BASE_URL="${baseUrl}" is not a URL.`);
    }
    if (host === VERTEX_GLOBAL_HOST) {
      throw new ConfigError(
        `ANTHROPIC_VERTEX_BASE_URL="${baseUrl}" is the GLOBAL Vertex endpoint — refused for the ` +
        `same reason a \`global\` region is, and refused HERE because a base URL steers the SDK ` +
        `past every region variable. A regional host is <region>-${VERTEX_GLOBAL_HOST}.`,
      );
    }
  }

  const useVertexRaw = (env["CLAUDE_CODE_USE_VERTEX"] ?? "").trim().toLowerCase();
  const enabled = VERTEX_ON_VALUES.has(useVertexRaw);
  if (useVertexRaw !== "" && !enabled && !OFF_VALUES.has(useVertexRaw)) {
    // Warn rather than refuse: muninn and the SDK now AGREE this is off, so the
    // failure is loud either way — `assertHaveAuth()` demands an Anthropic
    // credential and says so. Silence is the only bad answer.
    log.warn(
      "Unrecognized value for CLAUDE_CODE_USE_VERTEX: \"{value}\" — treated as OFF, which is what " +
      "the Agent SDK does too (it accepts 1/true/yes/on)",
      { value: useVertexRaw },
    );
  }

  const sdkProject = read("ANTHROPIC_VERTEX_PROJECT_ID");
  const muninnProject = read("VERTEX_PROJECT_ID");
  const projectId = sdkProject ?? muninnProject;
  const projectIdSource = sdkProject ? ("ANTHROPIC_VERTEX_PROJECT_ID" as const)
    : muninnProject ? ("VERTEX_PROJECT_ID" as const) : null;
  const region = cloudMlRegion ?? vertexRegion;
  const regionSource = cloudMlRegion ? ("CLOUD_ML_REGION" as const)
    : vertexRegion ? ("VERTEX_REGION" as const) : null;

  // The mismatch checks sit BELOW the `enabled` gate deliberately. `CLOUD_ML_REGION`
  // is a generic Google variable that unrelated tooling sets, so refusing a boot
  // over it disagreeing with a stale `VERTEX_REGION` — on an instance that
  // touches Vertex nowhere — would be a hard failure with no upside. When Vertex
  // IS on, one of the two is dead config and guessing which the operator meant is
  // not this layer's job. (The `global` refusals above are unconditional for the
  // opposite reason: there the degrade direction is dangerous, not merely noisy.)
  if (enabled && sdkProject !== null && muninnProject !== null && sdkProject !== muninnProject) {
    throw new ConfigError(
      `ANTHROPIC_VERTEX_PROJECT_ID="${sdkProject}" and VERTEX_PROJECT_ID="${muninnProject}" disagree. ` +
      `The Agent SDK reads only the first, so the second is dead config — set one, or set both alike.`,
    );
  }
  if (enabled && cloudMlRegion !== null && vertexRegion !== null && cloudMlRegion !== vertexRegion) {
    throw new ConfigError(
      `CLOUD_ML_REGION="${cloudMlRegion}" and VERTEX_REGION="${vertexRegion}" disagree. ` +
      `The Agent SDK reads only the first, so the second is dead config — set one, or set both alike.`,
    );
  }

  if (enabled && sdkProject === null) {
    throw new ConfigError(
      "CLAUDE_CODE_USE_VERTEX is on but ANTHROPIC_VERTEX_PROJECT_ID is not set. That is the name " +
      "the Agent SDK reads; muninn does not export VERTEX_PROJECT_ID into it, and the SDK with no " +
      "project of its own falls back to whatever project Application Default Credentials resolve " +
      "to — a different project, silently.",
    );
  }
  if (enabled && cloudMlRegion === null) {
    throw new ConfigError(
      "CLAUDE_CODE_USE_VERTEX is on but CLOUD_ML_REGION is not set. A base URL does not substitute: " +
      "the Agent SDK builds the resource path from the region regardless, and its default is " +
      "\"us-east5\", which is almost certainly not the region you meant. Set CLOUD_ML_REGION " +
      "explicitly (use \"eu\" alongside the EU multi-region base URL).",
    );
  }

  return { enabled, projectId, projectIdSource, region, regionSource, baseUrl, perModelRegions };
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
  if (isNaN(parsed)) throw new ConfigError(`Environment variable ${name} must be a valid integer, got: "${raw}"`);
  return parsed;
}

export function loadConfig() {
  const whisperModelPath = optionalEnv("WHISPER_MODEL_PATH", "./models/ggml-base.en.bin");
  return {
    // WHICH deployment this is. Read through `resolveServingProfile()` — the
    // same parse the seams below the config layer use, so a field here can
    // never disagree with what they enforce.
    profile: resolveServingProfile(),
    // The Vertex credential seam. A field AND a getter, per the pair rule above:
    // `assertHaveAuth()` (claude-sdk connector) has no `Config` to read from, and
    // `loadConfig` calling the same resolver is what keeps them from disagreeing.
    // Nothing here MOVES a model — it declares which project and region a Vertex
    // call would use, and refuses `global` at boot rather than per turn.
    vertex: resolveVertexConfig(),
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
