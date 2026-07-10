import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLog } from "../logging.ts";
import { isEditableBotField, validateBotConfigField, type EditableBotField } from "./config.ts";

const log = getLog("bots", "config-edit");

/** Same base dir discovery scans (`discoverBotsInternal`). */
const DEFAULT_BOTS_DIR = resolve(import.meta.dir, "../../bots");

export interface WriteConfigResult {
  /** Absolute path written. */
  path: string;
  /** true when the field was removed (reverted to default) rather than set. */
  cleared: boolean;
}

/**
 * Write a single editable field into `bots/<name>/config.json` IN PLACE — it is
 * the git-synced source of truth (via `config:sync`), so this is the only place
 * the change should land; a DB override would silently fork it. Validates with
 * the SAME rules discovery uses (`validateBotConfigField`) and throws
 * `Error(message)` on an invalid value or unknown bot. `value === null` removes
 * the key (revert to default). Only the edited field is touched, and a
 * config.json is created (with just that field) only for a real bot folder.
 *
 * NOT hot — the running process already discovered its bots, so the caller must
 * tell the user this "applies on restart".
 *
 * `opts.baseDir` overrides the bots dir (round-trip test uses a temp dir).
 */
export function writeBotConfigField(
  name: string,
  field: string,
  value: unknown,
  opts: { baseDir?: string } = {},
): WriteConfigResult {
  if (!isEditableBotField(field)) {
    throw new Error(`Unknown editable field "${field}"`);
  }
  const editableField: EditableBotField = field;
  const err = validateBotConfigField(name, editableField, value);
  if (err) throw new Error(err);

  const base = opts.baseDir ?? DEFAULT_BOTS_DIR;
  const dir = join(base, name);
  if (!existsSync(join(dir, "CLAUDE.md"))) {
    throw new Error(`Unknown bot "${name}" (no bots/${name}/CLAUDE.md)`);
  }

  const configPath = join(dir, "config.json");
  let obj: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      obj = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`config.json for "${name}" is not valid JSON: ${String(e)}`);
    }
  }

  const cleared = value === null;
  if (cleared) delete obj[editableField];
  else obj[editableField] = value;

  // Atomic write (temp + rename) — config.json is the git-synced source of
  // truth and discovery JSON.parses it at startup; a crash mid-write must not
  // leave it truncated.
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, configPath);
  log.info("Wrote bot \"{name}\" config.json field {field} ({action})", {
    botName: name,
    name,
    field: editableField,
    action: cleared ? "cleared" : "set",
  });
  return { path: configPath, cleared };
}
