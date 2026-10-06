/**
 * The reader's **Publish to felles** control: a page in a NAV wiki → the
 * `melosys-felles` bucket the melosys-muninn pod mirrors read-only.
 *
 * muninn uploads nothing itself. It runs the operator's own
 * `publiser-felles-wiki.ts` (in the `muninn-nais` repo) — the same command line
 * the operator types by hand — because that script's scanner is the only guard
 * against personal data reaching a page the whole team can read, and a second
 * implementation here would be a second, weaker guard.
 *
 *     <bun> --no-env-file <FELLES_WIKI_PUBLISH_BIN> [--dry-run] [--tillat-ident] <wiki root> ./<relPath>
 *
 * Two variables, both required, both read at REQUEST time:
 *   - `FELLES_WIKI_PUBLISH_BIN` — absolute path to the script.
 *   - `FELLES_WIKI_PUBLISH_WIKIS` — comma-separated wiki NAMES that offer the
 *     control. A name allowlist rather than "every wiki": the button on a mimir
 *     page would put a private page one click from a NAV bucket.
 *
 * Off on any profile but `default`: the pod is the mirror's reader, never a
 * publisher, and `MUNINN_PROFILE=nais` drops the route with the rest of the wiki
 * group anyway.
 */
import path from "node:path";
import { resolveServingProfile } from "../config.ts";
import { isReadonlyWikiRoot } from "./readonly.ts";

export const FELLES_PUBLISH_BIN_ENV = "FELLES_WIKI_PUBLISH_BIN";
export const FELLES_PUBLISH_WIKIS_ENV = "FELLES_WIKI_PUBLISH_WIKIS";

export interface FellesPublishConfig {
  /** Absolute script path, or null when the control is off. */
  bin: string | null;
  /** `FELLES_WIKI_BUCKET` as the route's child sees it, so the copied command
   *  targets the same bucket as the button. Null when unset. */
  bucket: string | null;
  /** Wiki names that offer the control, lower-cased (the registry matches
   *  names without case). */
  wikis: ReadonlySet<string>;
}

/** Parse the two variables. Off (`bin: null`) unless both are set, the path is
 *  absolute and this is the `default` profile. */
export function fellesPublishConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): FellesPublishConfig {
  const wikis = new Set(
    (env[FELLES_PUBLISH_WIKIS_ENV] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const raw = (env[FELLES_PUBLISH_BIN_ENV] ?? "").trim();
  let profileOk = false;
  try {
    profileOk = resolveServingProfile(env) === "default";
  } catch {
    // An unknown profile refuses the boot elsewhere; here it simply means off.
  }
  const bin = raw && path.isAbsolute(raw) && wikis.size > 0 && profileOk ? raw : null;
  return { bin, wikis, bucket: env.FELLES_WIKI_BUCKET?.trim() || null };
}

/** Does this wiki offer the control? Keyed on the registry NAME the reader sends. */
export function fellesPublishableFor(wikiName: string | undefined, config: FellesPublishConfig): boolean {
  return !!config.bin && !!wikiName && config.wikis.has(wikiName.toLowerCase());
}

/** `{ fellesPublish: { bin, bucket? } }` for `/api/wiki/pages` on a wiki that
 *  offers the control, else `{}` — including on a `WIKI_READONLY_ROOTS` root,
 *  since publishing ships the page off the machine. `bin` and `bucket` let the
 *  dialog build the copyable command line. */
export function fellesPublishPayloadField(
  wikiName: string | undefined,
  root: string | undefined,
  config: FellesPublishConfig = fellesPublishConfigFromEnv(),
  isReadonlyRoot: (root: string) => boolean = isReadonlyWikiRoot,
): { fellesPublish?: { bin: string; bucket?: string } } {
  if (!fellesPublishableFor(wikiName, config) || !config.bin || !root || isReadonlyRoot(root)) return {};
  return { fellesPublish: { bin: config.bin, ...(config.bucket ? { bucket: config.bucket } : {}) } };
}

export type FellesAction = "publish" | "remove";

/** The script's arguments after its path, in the order the operator types them.
 *
 *  publish: `[--dry-run] [--tillat-ident] <root> ./<relPath>` — the `./` keeps a
 *  dash-led page from being read as a flag.
 *  remove:  `--fjern [--dry-run] --ja -- <relPath>` — here the relPath IS the
 *  bucket object name, which a `./` would change, so `--` guards it instead
 *  (Bun swallows a `--` only directly after the script path). It goes in NFC,
 *  because the script uploads `rel.normalize("NFC")` but deletes the name it is
 *  given, and readdir hands back an NFD path as it was written. `--ja` answers
 *  the script's own prompt; the dialog's confirm step is where the reader is asked. */
export function fellesScriptArgs(opts: {
  action: FellesAction;
  dryRun: boolean;
  allowIdent: boolean;
  root: string;
  relPath: string;
}): string[] {
  const dry = opts.dryRun ? ["--dry-run"] : [];
  if (opts.action === "remove") return ["--fjern", ...dry, "--ja", "--", opts.relPath.normalize("NFC")];
  return [...dry, ...(opts.allowIdent ? ["--tillat-ident"] : []), opts.root, "./" + opts.relPath];
}

/** Names the child inherits. `PATH` finds `gcloud`; `HOME` and the `CLOUDSDK_*`
 *  family are where gcloud keeps its login; `TMPDIR`, `USER`, `LOGNAME`,
 *  `LANG` and `LC_ALL` are what gcloud's runtime expects; `FELLES_WIKI_BUCKET`
 *  is the script's own bucket override. The route also passes
 *  `--no-env-file`: without it Bun reloads muninn's `.env` from the working
 *  directory and every secret this list leaves out comes back. */
const CHILD_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "FELLES_WIKI_BUCKET"];
const CHILD_ENV_PREFIXES = ["CLOUDSDK_"];

export function fellesPublishChildEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || !value) continue;
    if (CHILD_ENV_NAMES.includes(name) || CHILD_ENV_PREFIXES.some((p) => name.startsWith(p))) env[name] = value;
  }
  return env;
}
