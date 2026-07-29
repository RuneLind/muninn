import { getLog } from "../logging.ts";

const log = getLog("watchers", "config");

/**
 * Shared validation for numeric watcher-config knobs read off the DB's JSONB `config`.
 *
 * Same stance as bot-config discovery: a wrong-typed or out-of-range value is **warned
 * about and dropped** (the field falls back to its default) rather than carried
 * downstream, and a bad field never aborts the run. Falsy-but-valid values inside the
 * range (e.g. `0` when `min` is 0) are kept.
 *
 * **Naming a `max` is mandatory, not decorative.** Several of these knobs exist precisely
 * to CAP something, so a fat-fingered `1e9` must not silently uncap them — the bound is
 * what makes "invalid ⇒ fall back" true for large values, not just for wrong types.
 *
 * `dedupeKey` makes the warn fire **once per process per key**. Knobs are re-read on every
 * watcher run (every 2h, forever), and a mistyped value is a static config defect — warning
 * ~12×/day buries the one-off signal it exists to give. Callers key it
 * `<watcherId>:<raw>` so *correcting* a bad value to a different bad value warns again (a
 * genuinely new defect) while the same bad value stays quiet. Omit for pure/one-shot
 * callers that want every warn.
 */
export function readIntKnob(
  raw: unknown,
  opts: {
    field: string;
    fallback: number;
    min: number;
    max: number;
    botName?: string;
    dedupeKey?: string;
  },
): number {
  const { field, fallback, min, max, botName, dedupeKey } = opts;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    if (dedupeKey !== undefined) {
      const seen = `${field}:${dedupeKey}`;
      if (warned.has(seen)) return fallback;
      warned.add(seen);
    }
    log.warn("Ignoring invalid {field}={value} (want an integer in [{min}, {max}]); using {fallback}", {
      botName,
      field,
      value: String(raw),
      min,
      max,
      fallback,
    });
    return fallback;
  }
  return raw;
}

/** Keys already warned about this process — see `dedupeKey` above. Bounded by distinct static defects. */
const warned = new Set<string>();
