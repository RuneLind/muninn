import { getLog } from "./logging.ts";
import type { AnswerGroups } from "./format/question.ts";

const log = getLog("config");

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
const PROFILE_ENV = "MUNINN_PROFILE";

/**
 * The serving profiles. `default` is today's muninn — every route registered,
 * every vertical present. `nais` is the pod: no wiki working trees, no
 * `yt-dlp`/`ffmpeg`, colleagues on the other side of the door.
 */
/**
 * A comma-separated list of wiki NAMES, trimmed and lower-cased (the registry
 * matches names without case), blanks dropped. `FELLES_WIKI_PUBLISH_WIKIS` and
 * `WIKI_ANSWER_WIKIS` both read this way.
 */
export function parseWikiNameList(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Answer cards: which wikis take answers, and whose answers they are with auth off. */
export interface WikiAnswerConfig {
  /** `WIKI_ANSWER_WIKIS`, lower-cased. Empty ⇒ every card is read-only. */
  wikis: ReadonlySet<string>;
  /** `WIKI_ANSWER_OWNER`, trimmed: the author of every answer under
   *  `MUNINN_AUTH=off`, and who a question is for when its page names nobody.
   *  Null ⇒ a write under auth off is refused. */
  owner: string | null;
  /** `WIKI_ANSWER_SCANNER`, trimmed: the module that scans an answer body
   *  before it is stored (`src/wiki/answer-scanner.ts`). Null/absent ⇒ unset:
   *  `nais` then refuses every answer with a body, `default` stores unscanned. */
  scanner?: string | null;
  /** `WIKI_ANSWER_GROUPS`: named groups a `<Question>` can be asked of. Absent
   *  or empty ⇒ no groups, and a target named `fag` is a person. */
  groups?: AnswerGroups;
  /** Why entries of `WIKI_ANSWER_GROUPS` were dropped or merged — positions and
   *  group names, never an ident. Carried, not logged: `loadConfig()` runs
   *  before `setupLogging()`; the boot line (`answerGroupsBootLines`) warns. */
  groupWarnings?: string[];
}

/** A group name as `WIKI_ANSWER_GROUPS` takes it, after lower-casing. */
const ANSWER_GROUP_NAME_RE = /^[a-z0-9æøå_-]+$/;
/** A NAV ident after upper-casing: letters and digits. */
const ANSWER_GROUP_IDENT_RE = /^[A-Z0-9]+$/;

/**
 * `WIKI_ANSWER_GROUPS` — `fag=A123456,B234567;utvikler=C345678`. Group names
 * are lower-cased, idents trimmed and upper-cased, empty entries and empty
 * idents ignored; an ident may be in several groups, and a name given twice
 * merges. A malformed entry is dropped with a warning naming its position and
 * why — never its idents, which are personal data.
 */
export function parseAnswerGroups(raw: string | undefined): { groups: AnswerGroups; warnings: string[] } {
  const groups = new Map<string, Set<string>>();
  const warnings: string[] = [];
  const entries = (raw ?? "").split(";").map((e) => e.trim()).filter(Boolean);
  entries.forEach((entry, i) => {
    const at = `WIKI_ANSWER_GROUPS entry ${i + 1}`;
    const eq = entry.indexOf("=");
    if (eq === -1) return void warnings.push(`${at} dropped: no "=" between the group name and its members`);
    const name = entry.slice(0, eq).trim().toLowerCase();
    if (!ANSWER_GROUP_NAME_RE.test(name)) {
      return void warnings.push(`${at} dropped: the group name must be letters, digits, "_" or "-"`);
    }
    const idents = entry.slice(eq + 1).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (idents.length === 0) return void warnings.push(`${at} dropped: group "${name}" names no members`);
    if (!idents.every((x) => ANSWER_GROUP_IDENT_RE.test(x))) {
      return void warnings.push(`${at} dropped: a member of group "${name}" is not a NAV ident (letters and digits only)`);
    }
    const members = groups.get(name);
    if (members) warnings.push(`${at}: group "${name}" is defined again — its members are merged`);
    const set = members ?? new Set<string>();
    for (const x of idents) set.add(x);
    groups.set(name, set);
  });
  return { groups, warnings };
}

/** `WIKI_ANSWER_GROUPS` at boot: the dropped entries as warnings, and an info
 *  line with group names and member counts — never an ident. */
export function answerGroupsBootLines(cfg: WikiAnswerConfig): { info: string | null; warnings: string[] } {
  const groups = cfg.groups ?? new Map();
  const info = groups.size
    ? `Answer groups: ${[...groups].map(([name, members]) => `${name} (${members.size} member${members.size === 1 ? "" : "s"})`).join(", ")}`
    : null;
  return { info, warnings: cfg.groupWarnings ?? [] };
}

/** `WIKI_ANSWER_WIKIS` + `WIKI_ANSWER_OWNER` + `WIKI_ANSWER_SCANNER` + `WIKI_ANSWER_GROUPS`. A `Config` field and a getter,
 *  the {@link resolveServingProfile} pair rule: one parse either way. */
export function resolveWikiAnswerConfig(env: Record<string, string | undefined> = process.env): WikiAnswerConfig {
  const { groups, warnings } = parseAnswerGroups(env.WIKI_ANSWER_GROUPS);
  return {
    wikis: parseWikiNameList(env.WIKI_ANSWER_WIKIS),
    owner: (env.WIKI_ANSWER_OWNER ?? "").trim() || null,
    scanner: (env.WIKI_ANSWER_SCANNER ?? "").trim() || null,
    groups,
    groupWarnings: warnings,
  };
}

/** Answer retention (decision D17): day counts, null ⇒ that rule is off. Both
 *  null ⇒ no sweep at all, including the redacted rule. */
export interface WikiAnswerRetention {
  /** `WIKI_ANSWER_RETENTION_DAYS`: delete an answer this long after its latest `exported_at`. */
  exportedDays: number | null;
  /** `WIKI_ANSWER_UNEXPORTED_DAYS`: delete a never-exported answer this long after its latest version. */
  unexportedDays: number | null;
  /** Variables set to 0, turned OFF instead. Carried, not logged here:
   *  `loadConfig()` runs before `setupLogging()`, so a warn from here is
   *  dropped. The boot line (`answerRetentionBootLines`) warns about them. */
  refused: { name: string; value: string }[];
}

/** One retention day count. Unset/blank ⇒ off. Digits only — this is a
 *  deletion window, so `1e3`, `1.9`, `30d`, `-5` refuse the boot with
 *  `ConfigError` rather than being read as something else. 0 is OFF, never 0
 *  days (which would delete every answer on the next sweep), and is reported
 *  in `refused`. */
function retentionDays(
  env: Record<string, string | undefined>,
  name: string,
  refused: WikiAnswerRetention["refused"],
): number | null {
  const raw = (env[name] ?? "").trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`Environment variable ${name} must be a whole number of days, got: "${raw}"`);
  const days = Number(raw);
  if (days >= 1) return days;
  refused.push({ name, value: raw });
  return null;
}

/** `WIKI_ANSWER_RETENTION_DAYS` + `WIKI_ANSWER_UNEXPORTED_DAYS`. */
export function resolveWikiAnswerRetention(env: Record<string, string | undefined> = process.env): WikiAnswerRetention {
  const refused: WikiAnswerRetention["refused"] = [];
  const exportedDays = retentionDays(env, "WIKI_ANSWER_RETENTION_DAYS", refused);
  const unexportedDays = retentionDays(env, "WIKI_ANSWER_UNEXPORTED_DAYS", refused);
  return { exportedDays, unexportedDays, refused };
}

/** Does this wiki take answers? Keyed on the registry NAME. */
export function wikiTakesAnswers(wikiName: string | undefined, cfg: WikiAnswerConfig): boolean {
  return !!wikiName && cfg.wikis.has(wikiName.toLowerCase());
}

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
export const VERTEX_GLOBAL_REGION = "global";

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
export const VERTEX_GLOBAL_HOST = "aiplatform.googleapis.com";

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

// ── Wiki bucket mirrors (`src/wiki/bucket-mirror.ts`) ─────────────

export interface WikiBucketMirrorEntry {
  bucket: string;
  /** Object-name prefix, `""` or ending in `/`. */
  prefix: string;
  /** Absolute, normalized local root as configured (not symlink-resolved). */
  root: string;
}

export interface WikiBucketMirrorConfig {
  mirrors: WikiBucketMirrorEntry[];
  /** `WIKI_BUCKET_MIRRORS` entries refused at parse time, for the boot warn. */
  refused: { entry: string; reason: string }[];
  /** A `WIKI_BUCKET_MIRROR_INTERVAL_MS` value that was ignored, for the boot warn. */
  intervalRefused: { value: string; reason: string } | null;
  intervalMs: number;
  /** GCS JSON API base, no trailing slash. */
  gcsBase: string;
  /** `WIKI_BUCKET_MIRROR_PROJECT_NUMBER`: the project every mirrored bucket
   *  must belong to, or null when ownership is not pinned. */
  projectNumber: string | null;
  /** A `WIKI_BUCKET_MIRROR_PROJECT_NUMBER` value that was ignored, for the boot warn. */
  projectNumberRefused: { value: string; reason: string } | null;
}

export const WIKI_BUCKET_MIRROR_DEFAULT_INTERVAL_MS = 120_000;
export const WIKI_BUCKET_MIRROR_MIN_INTERVAL_MS = 1_000;
/** One day. Far under the 2^31-1 ms `setTimeout` ceiling, past which Bun fires
 *  the timer after 1 ms — a tight list loop instead of a slow one. */
export const WIKI_BUCKET_MIRROR_MAX_INTERVAL_MS = 24 * 60 * 60_000;
export const GCS_DEFAULT_BASE = "https://storage.googleapis.com";

/** GCS bucket-name syntax: lowercase alnum, `-`, `_`, `.`; alnum at both ends. */
const GCS_BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
/** C0, DEL, C1, the Unicode line/paragraph separators and the bidi overrides —
 *  the same set `bucket-mirror.ts` refuses in object names. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Parse `WIKI_BUCKET_MIRRORS` — comma-separated `gs://<bucket>[/<prefix>]=<absolute root>`.
 * Pure syntax only; a bad entry is returned in `refused` (the caller warns),
 * never thrown, so a typo drops one mirror rather than the boot. The filesystem
 * safety rules (inside tmpdir, listed read-only, marker) are the mirror's own,
 * applied when it starts.
 */
export function parseWikiBucketMirrors(raw: string | undefined): {
  mirrors: WikiBucketMirrorEntry[];
  refused: { entry: string; reason: string }[];
} {
  const mirrors: WikiBucketMirrorEntry[] = [];
  const refused: { entry: string; reason: string }[] = [];
  for (const rawEntry of (raw ?? "").split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const refuse = (reason: string) => refused.push({ entry, reason });
    const eq = entry.indexOf("=");
    if (eq < 0) { refuse("expected gs://<bucket>[/<prefix>]=<absolute root>"); continue; }
    const source = entry.slice(0, eq).trim();
    const rootRaw = entry.slice(eq + 1).trim();
    if (!source.startsWith("gs://")) { refuse("source must start with gs://"); continue; }
    const rest = source.slice("gs://".length);
    const slash = rest.indexOf("/");
    const bucket = slash < 0 ? rest : rest.slice(0, slash);
    const prefixRaw = slash < 0 ? "" : rest.slice(slash + 1);
    if (!GCS_BUCKET_RE.test(bucket)) { refuse(`"${bucket}" is not a valid bucket name`); continue; }
    const prefixTrim = prefixRaw.replace(/^\/+|\/+$/g, "");
    if (
      CONTROL_CHARS.test(prefixTrim) || prefixTrim.includes("\\") ||
      (prefixTrim !== "" && prefixTrim.split("/").some((s) => s === "" || s === "." || s === ".."))
    ) { refuse("prefix has an empty, '.' or '..' segment, a backslash or a control character"); continue; }
    const prefix = prefixTrim === "" ? "" : `${prefixTrim}/`;
    if (!rootRaw.startsWith("/")) { refuse("root must be an absolute path"); continue; }
    let root = rootRaw.replace(/\/+$/, "") || "/";
    // `path.posix.normalize` without importing node:path into the config layer.
    root = root.split("/").reduce<string[]>((acc, seg) => {
      if (seg === "" || seg === ".") return acc;
      if (seg === "..") acc.pop(); else acc.push(seg);
      return acc;
    }, []).join("/");
    root = `/${root}`;
    if (root === "/") { refuse("root must not be /"); continue; }
    if (mirrors.some((m) => m.root === root)) { refuse("root is already used by another mirror"); continue; }
    mirrors.push({ bucket, prefix, root });
  }
  return { mirrors, refused };
}

/**
 * The bucket-mirror config: one resolver. Refusals are CARRIED, not logged:
 * `loadConfig()` runs before `setupLogging()`, so a warn here is dropped
 * (measured in the acceptance sweep). `startWikiBucketMirrors` logs them.
 */
export function resolveWikiBucketMirrorConfig(): WikiBucketMirrorConfig {
  const { mirrors, refused } = parseWikiBucketMirrors(process.env.WIKI_BUCKET_MIRRORS);
  const { intervalMs, intervalRefused } = parseWikiBucketMirrorInterval(process.env.WIKI_BUCKET_MIRROR_INTERVAL_MS);
  const gcsBase = (nullableEnv("WIKI_BUCKET_MIRROR_GCS_BASE") ?? GCS_DEFAULT_BASE).replace(/\/+$/, "");
  const { projectNumber, projectNumberRefused } = parseWikiBucketMirrorProjectNumber(process.env.WIKI_BUCKET_MIRROR_PROJECT_NUMBER);
  return { mirrors, refused, intervalRefused, intervalMs, gcsBase, projectNumber, projectNumberRefused };
}

/** Lenient like the interval: a malformed project number is a carried refusal
 *  and ownership stays unpinned (warned), never a boot failure. */
export function parseWikiBucketMirrorProjectNumber(raw: string | undefined): {
  projectNumber: string | null;
  projectNumberRefused: { value: string; reason: string } | null;
} {
  const value = raw?.trim() ?? "";
  if (!value) return { projectNumber: null, projectNumberRefused: null };
  if (!/^[1-9]\d{0,19}$/.test(value)) {
    return { projectNumber: null, projectNumberRefused: { value, reason: "not a project number (digits only) — bucket ownership is not pinned" } };
  }
  return { projectNumber: value, projectNumberRefused: null };
}

/** Lenient on purpose (not `optionalEnvInt`, which throws): a typo in a poll
 *  interval must not crashloop the pod. Anything but a plain integer inside
 *  [min, max] is the default plus a carried refusal. */
export function parseWikiBucketMirrorInterval(raw: string | undefined): {
  intervalMs: number;
  intervalRefused: { value: string; reason: string } | null;
} {
  const value = raw?.trim() ?? "";
  if (!value) return { intervalMs: WIKI_BUCKET_MIRROR_DEFAULT_INTERVAL_MS, intervalRefused: null };
  const fallback = (reason: string) => ({
    intervalMs: WIKI_BUCKET_MIRROR_DEFAULT_INTERVAL_MS,
    intervalRefused: { value, reason: `${reason} — using the default ${WIKI_BUCKET_MIRROR_DEFAULT_INTERVAL_MS} ms` },
  });
  if (!/^\d+$/.test(value)) return fallback("not a whole number of milliseconds");
  const n = Number(value);
  if (n < WIKI_BUCKET_MIRROR_MIN_INTERVAL_MS) return fallback(`below ${WIKI_BUCKET_MIRROR_MIN_INTERVAL_MS} ms`);
  if (n > WIKI_BUCKET_MIRROR_MAX_INTERVAL_MS) return fallback(`above ${WIKI_BUCKET_MIRROR_MAX_INTERVAL_MS} ms`);
  return { intervalMs: n, intervalRefused: null };
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
 * `src/auth/origin.ts` (every side-effecting request, in every mode), by
 * `src/auth/cors.ts` (which origin, if any, an `Access-Control-Allow-Origin`
 * names) and on the `/chat/ws` upgrade in an authenticating mode. Required
 * there; optional with auth off, where it only adds origins.
 *
 * The loopback origins at the configured `DASHBOARD_PORT` are accepted without
 * being listed. In an authenticating mode every other origin muninn is REACHED
 * at — the tailnet name `tailscale serve` publishes, a LAN address under
 * `DASHBOARD_HOST=0.0.0.0`, an extension — must be an entry here, spelled
 * exactly as the browser sends it (scheme included). With auth off, extensions
 * and same-origin pages pass without it.
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

/**
 * {@link optionalEnvInt} for a value that has to be at least 1, refusing rather
 * than passing a wipe through.
 *
 * The RETENTION windows are what this exists for. They are day counts the
 * sweeper subtracts from `NOW()`, so `0` is not "keep nothing new" — it is
 * `created_at < NOW() - 0 days`, which matches every row, and the next
 * scheduler tick empties the table. A negative value reaches into the future
 * and does the same. Neither is recoverable, and neither looks like a mistake
 * in a `.env`.
 *
 * **Two bands, two answers.** A value that PARSES and is below 1 (`=0`, `=-7`)
 * is warn-and-defaulted — the opposite of `resolveServingProfile`'s rule and for
 * the same reason read the other way: there the degrade direction was "serve
 * everything", here it is "delete everything", so the safe answer is the shipped
 * window plus a line saying the value was refused. Warned once per
 * `<name>=<value>`, since `loadConfig` runs more than once in a process. A value
 * that does not parse as an integer at all (`=ninety`) still throws
 * `ConfigError` from {@link optionalEnvInt} and refuses the boot, which this
 * function deliberately does not soften: an unparseable retention names no
 * window, so there is nothing to be lenient ABOUT, and refusing is the same
 * answer every other `optionalEnvInt` caller gets. An empty or unset value is
 * the default, as everywhere.
 */
export function positiveEnvInt(name: string, defaultValue: number): number {
  const parsed = optionalEnvInt(name, defaultValue);
  if (parsed >= 1) return parsed;
  const key = `${name}=${parsed}`;
  if (!warnedEnvFlagValues.has(key)) {
    warnedEnvFlagValues.add(key);
    log.warn(
      "{name} is {value}, which would delete every row on the next sweep — refused, using the default of {fallback} day(s)",
      { name, value: parsed, fallback: defaultValue },
    );
  }
  return defaultValue;
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
    // GCS buckets mirrored into read-only wiki roots (`src/wiki/bucket-mirror.ts`).
    wikiBucketMirrors: resolveWikiBucketMirrorConfig(),
    dashboardPort: optionalEnvInt("DASHBOARD_PORT", 3010),
    claudeTimeoutMs: optionalEnvInt("CLAUDE_TIMEOUT_MS", 120000),
    claudeModel: optionalEnv("CLAUDE_MODEL", "sonnet"),
    databaseUrl: requireEnv("DATABASE_URL"),
    whisperModelPath,
    // TikTok summarizer transcription model. Falls back to the shared whisper
    // model so English-only bots keep working; set TIKTOK_WHISPER_MODEL_PATH to
    // a multilingual model (e.g. ggml-base.bin) without touching Telegram voice.
    tiktokWhisperModelPath: optionalEnv("TIKTOK_WHISPER_MODEL_PATH", whisperModelPath),
    // Vimeo's no-captions fallback (v2 PR 5) transcribes conference talks, many
    // of them Norwegian, so it wants a MULTILINGUAL model; the shared default
    // is English-only. Falls back through the TikTok path so one multilingual
    // model set there covers both.
    vimeoWhisperModelPath: optionalEnv(
      "VIMEO_WHISPER_MODEL_PATH",
      optionalEnv("TIKTOK_WHISPER_MODEL_PATH", whisperModelPath),
    ),
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
    // The one claude-usage URL a BROWSER is ever given: the base of a session
    // drill-down link on a wiki page's provenance chips. Separate from the field
    // above on purpose — that one is a server-side loopback/tailnet address this
    // process fetches, and handing it to a viewer's browser is the mixed-content
    // and wrong-host failure the server-side proxy exists to avoid. Null ⇒ the
    // chips carry the session id as copyable text and no link, which is the
    // default and is fine: the id is what a search takes.
    claudeUsagePublicUrl: nullableEnv("CLAUDE_USAGE_PUBLIC_URL"),
    wikiAnswers: resolveWikiAnswerConfig(),
    wikiAnswerRetention: resolveWikiAnswerRetention(),
    knowledgeViewableCollections: optionalEnv("KNOWLEDGE_VIEWABLE_COLLECTIONS", "").split(",").map(s => s.trim()).filter(Boolean),
    yggdrasilMcpUrl: optionalEnv("YGGDRASIL_MCP_URL", "http://127.0.0.1:9130"),
    tracingEnabled: optionalEnv("TRACING_ENABLED", "true") === "true",
    tracingRetentionDays: optionalEnvInt("TRACING_RETENTION_DAYS", 7),
    tracingCaptureToolOutputs: optionalEnv("TRACING_CAPTURE_TOOL_OUTPUTS", "true") === "true",
    // `positiveEnvInt`, not `optionalEnvInt`: a retention of 0 or less is a
    // WIPE, not a short window — see the helper.
    promptSnapshotsRetentionDays: positiveEnvInt("PROMPT_SNAPSHOTS_RETENTION_DAYS", 3),
    // Capture prompts outlive both their chat siblings and their own traces: the
    // summary they produced is read months later, and "what was this written
    // from?" is the question `GET /api/summaries/prompt?url=` answers from this row.
    promptSnapshotsCaptureRetentionDays: positiveEnvInt("PROMPT_SNAPSHOTS_CAPTURE_RETENTION_DAYS", 90),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
