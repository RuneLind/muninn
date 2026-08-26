/**
 * The claimed-id and CORS inventories, as COMMANDS rather than numbers.
 *
 * §2 of the NAV-login plan makes this a rule rather than a style: the last two
 * drafts of that document each cited a route count that had already gone stale,
 * and the narrow form of the first grep - anchored on `app.<verb>("<path>` -
 * silently dropped the two routes registered as `app.on("HEAD", "<path>", ...)`,
 * where the path is the SECOND argument. Unguarded, those two are a 200/404
 * ORACLE over whether a colleague has a saved report or spec for a given Jira
 * key, and the chat client probes exactly that endpoint.
 *
 * So the inventory is re-derived from the source on every test run and compared
 * against `claimed-id-inventory.txt`. A route added next month lands as a diff
 * with no disposition, which is a test failure - the fail-closed shape, and the
 * only version of this that survives contact with a growing route surface.
 *
 * The three greps are the plan's, verbatim in their widened form.
 */
import { $ } from "bun";

export const CLAIMED_ID_PARAM_GREP =
  String.raw`app\.[a-z]+\(\s*("[A-Z]+"\s*,\s*)?"[^"]*:userId`;
/**
 * NB `viewer`. A claimed identity does not have to be CALLED `userId`, and the
 * first cut of this grep proved the point: `GET /api/events?viewer=<colleague>`
 * scoped the waterfall and phase pill to that person — yielding their live run
 * metadata and its `traceId`, which `GET /api/prompts/:traceId` expands into
 * their whole assembled prompt — and the route's own comment already said "PR C
 * is where the identity stops coming from the client". It matched no pattern
 * here, so the fixture advertised as fail-closed could not surface it.
 *
 * Any NEW query parameter that names a user has to be added here by hand. That
 * is a real limit of a grep-based inventory and is stated rather than papered
 * over: this catches what it knows about, and knowing about a name is a human
 * step.
 */
export const CLAIMED_ID_BODY_GREP = String.raw`body\.userId|query\("userId"\)|query\("viewer"\)`;
export const CORS_GREP = "Access-Control-Allow-Origin";

/** Every route registration, both forms, used to attribute a body/query read to
 *  the route it lives in. */
export const ROUTE_REGISTRATION_GREP = String.raw`app\.[a-z]+\(\s*("[A-Z]+"\s*,\s*)?"`;

/**
 * The files §2 names. The DIRECTORY, not a `*.ts` glob: `Bun.$` escapes its
 * interpolated arguments, so a glob would reach grep as a literal filename and
 * match nothing — silently, which for an inventory whose whole job is to be
 * complete is the worst possible failure. `grep -r` over the directory is also
 * what makes a new route FILE appear, which a hand-listed set would miss.
 */
const ROUTE_PATHS = ["src/chat/routes.ts", "src/dashboard/routes/"];

/**
 * What a row may say about itself. A row with anything else - or with nothing -
 * fails the fixture test, which is how a newly added route becomes visible work
 * rather than a silently unguarded surface.
 *
 * - `own-user-guard` - `requireOwnUser` is applied; the session identity wins.
 * - `admin-zone` - the route is in the ADMIN zone, where an "own" version is
 *   meaningless (`POST /api/users` mints a row; `/api/messages/:userId` is an
 *   operator read). It is now DENIED to role `user` by `src/auth/zones.ts`'s
 *   default-deny, so the claimed id it accepts is only ever named by an
 *   operator. This value REPLACED `admin-zone-deferred` when the zone model
 *   landed: replaced rather than added, so a row still carrying the old
 *   spelling fails the fixture loudly instead of quietly reading as covered.
 * - `doc-only` - a comment or a type, not a live read.
 *
 * There is deliberately no `cors-helper` value: `corsRows` counts LITERAL
 * occurrences of the header name, and a site that answers through
 * `src/auth/cors.ts` contains none, so such a row cannot exist. A disposition
 * no row can carry is a disposition that reads as coverage without being any.
 */
export const DISPOSITIONS = ["own-user-guard", "admin-zone", "doc-only"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface InventoryRow {
  readonly file: string;
  readonly signature: string;
}

async function grepLines(pattern: string, files: string[]): Promise<string[]> {
  // `.nothrow()`: grep exits 1 on "no matches", which is data here, not failure.
  const out = await $`grep -rnE ${pattern} ${files}`.nothrow().text();
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    // A test file naming a route is not a route.
    .filter((l) => !l.split(":")[0]!.includes(".test."));
}

function splitLine(line: string): { file: string; text: string } {
  const m = line.match(/^([^:]+):\d+:(.*)$/);
  if (!m) throw new Error(`Unparseable grep line: ${line}`);
  return { file: m[1]!, text: m[2]! };
}

/** `//`, `*` or `/*` — a mention in PROSE rather than a live line of code. */
function isCommentLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** One row per ROUTE - the method and the path, which is what a reader checks
 *  a disposition against. Line numbers are deliberately dropped: they churn on
 *  every edit and a fixture nobody can keep green stops being read. */
export async function claimedIdParamRows(): Promise<InventoryRow[]> {
  const rows: InventoryRow[] = [];
  for (const line of await grepLines(CLAIMED_ID_PARAM_GREP, ROUTE_PATHS)) {
    const { file, text } = splitLine(line);
    // Both registration forms: `app.get("/p"` and `app.on("HEAD", "/p"`.
    const leading = text.match(/app\.on\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"/);
    if (leading) {
      rows.push({ file, signature: `${leading[1]} ${leading[2]}` });
      continue;
    }
    const verb = text.match(/app\.([a-z]+)\(\s*"([^"]+)"/);
    if (!verb) throw new Error(`Unrecognised route registration: ${line}`);
    rows.push({ file, signature: `${verb[1]!.toUpperCase()} ${verb[2]}` });
  }
  return rows;
}

const CLAIMED_TOKENS = ["body.userId", 'query("userId")', 'query("viewer")'] as const;

/**
 * One row per (route, token) — NOT per file, and NOT a count of matching lines.
 *
 * Two defects in the first cut of this function are why:
 *
 *  1. **A per-FILE row cannot carry an honest disposition.** `src/chat/routes.ts`
 *     holds four `body.userId` reads: two guarded (`POST /conversations`,
 *     `POST /threads`) and two not (`PUT /bot-preferences/…/default-user`, which
 *     §4 sends to the admin zone). One row covering all four was labelled with
 *     the safer half — exactly the "a row with no disposition fails" rule,
 *     defeated by a row whose disposition was true of only some of its reads.
 *  2. **A count of matching LINES is a checksum over prose.** Comments naming
 *     `body.userId` matched, so a new unguarded read could land while a comment
 *     mentioning one was deleted and the number would not move.
 *
 * So: comment lines are excluded, and each read is attributed to the nearest
 * route registration ABOVE it. A read that is not inside any route registration
 * is attributed to `(module scope)`, which is itself worth seeing.
 */
export async function claimedIdBodyRows(): Promise<InventoryRow[]> {
  const rows = new Set<string>();
  const enclosing = new Map<string, string>();
  for (const line of await grepLines(ROUTE_REGISTRATION_GREP, ROUTE_PATHS)) {
    const { file, text } = splitLine(line);
    const n = Number(line.match(/^[^:]+:(\d+):/)![1]);
    const leading = text.match(/app\.on\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"/);
    const verb = text.match(/app\.([a-z]+)\(\s*"([^"]+)"/);
    const label = leading
      ? `${leading[1]} ${leading[2]}`
      : verb
        ? `${verb[1]!.toUpperCase()} ${verb[2]}`
        : null;
    if (label) enclosing.set(`${file}:${n}`, label);
  }

  for (const line of await grepLines(CLAIMED_ID_BODY_GREP, ROUTE_PATHS)) {
    const { file, text } = splitLine(line);
    if (isCommentLine(text)) continue;
    const n = Number(line.match(/^[^:]+:(\d+):/)![1]);
    // The nearest registration at or above this line, in the same file.
    let route = "(module scope)";
    let best = -1;
    for (const [key, label] of enclosing) {
      const [f, ln] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
      if (f === file && ln <= n && ln > best) { best = ln; route = label; }
    }
    for (const token of CLAIMED_TOKENS) {
      if (text.includes(token)) rows.add(`${file}\u0000${token} in ${route}`);
    }
  }
  return [...rows].map((r) => {
    const [file, signature] = r.split("\u0000");
    return { file: file!, signature: signature! };
  });
}

/**
 * The whole `src/` tree, not the route paths: §4's own inventory found wildcard
 * CORS on `src/chat/routes.ts` as well as on the dashboard files, and the point
 * of this row set is that nothing anywhere sets the header by hand any more.
 *
 * `src/auth/` is excluded because it is the MECHANISM — `cors.ts` sets the
 * header, and this file and `policy.ts` name it in prose.
 *
 * COMMENT lines are excluded for the same reason they are in
 * `claimedIdBodyRows`: a row set that counts prose is a checksum over prose. It
 * churned immediately — documenting this change added two mentions and turned
 * the fixture red for no behavioural reason — and the useful fact is "which
 * files SET this header", which after PR C should be none outside
 * `src/auth/cors.ts`. The raw grep is still asserted, separately and more
 * strictly, by the "no route file sets it by hand" case in `inventory.test.ts`.
 */
export async function corsRows(): Promise<InventoryRow[]> {
  const counts = new Map<string, number>();
  const out = await $`grep -rn ${CORS_GREP} src/`.nothrow().text();
  for (const line of out.split("\n").filter((l) => l.trim() !== "")) {
    const { file, text } = splitLine(line);
    if (file.includes(".test.") || file.startsWith("src/auth/")) continue;
    if (isCommentLine(text)) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()].map(([file, n]) => ({ file, signature: `Access-Control-Allow-Origin x${n}` }));
}

export function formatRows(rows: InventoryRow[]): string[] {
  return rows.map((r) => `${r.file} | ${r.signature}`).sort();
}
