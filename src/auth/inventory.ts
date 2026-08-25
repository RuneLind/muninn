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
export const CLAIMED_ID_BODY_GREP = String.raw`body\.userId|query\("userId"\)`;
export const CORS_GREP = "Access-Control-Allow-Origin";

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
 * - `admin-zone-deferred` - §4 assigns it to the ADMIN zone, where an "own"
 *   version is meaningless (`POST /api/users` mints a row; `/api/messages/:userId`
 *   is an operator read). The zone model is deferred, so nothing denies it
 *   today. Listed rather than forgotten.
 * - `cors-helper` - the site answers through `src/auth/cors.ts`, so its
 *   `Access-Control-Allow-Origin` is `*` only with `MUNINN_AUTH` off.
 * - `doc-only` - a comment or a type, not a live read.
 */
export const DISPOSITIONS = ["own-user-guard", "admin-zone-deferred", "cors-helper", "doc-only"] as const;
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

/**
 * One row per (file, token) with a COUNT.
 *
 * A body/query read is not a route registration, so there is no path to key on
 * and no stable per-site identity. The count is what makes the fixture
 * fail-closed anyway: a NEW `body.userId` read inside a file already on the
 * list moves the number, and moving the number is what forces someone to look.
 */
export async function claimedIdBodyRows(): Promise<InventoryRow[]> {
  const counts = new Map<string, number>();
  for (const line of await grepLines(CLAIMED_ID_BODY_GREP, ROUTE_PATHS)) {
    const { file, text } = splitLine(line);
    if (file.includes(".test.")) continue;
    for (const token of ["body.userId", 'query("userId")']) {
      if (text.includes(token)) {
        const key = `${file} ${token}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].map(([key, n]) => {
    const [file, token] = key.split(" ");
    return { file: file!, signature: `${token} x${n}` };
  });
}

/**
 * The whole `src/` tree, not the route paths: §4's own inventory found wildcard
 * CORS on `src/chat/routes.ts` as well as on the dashboard files, and the point
 * of this row set is that nothing anywhere sets the header by hand any more.
 *
 * `src/auth/` is excluded because it is the MECHANISM — `cors.ts` sets the
 * header, and this file and `policy.ts` name it in prose. Including them would
 * make the fixture churn on a comment edit, which is how a fixture stops being
 * read.
 */
export async function corsRows(): Promise<InventoryRow[]> {
  const counts = new Map<string, number>();
  const out = await $`grep -rn ${CORS_GREP} src/`.nothrow().text();
  for (const line of out.split("\n").filter((l) => l.trim() !== "")) {
    const { file } = splitLine(line);
    if (file.includes(".test.") || file.startsWith("src/auth/")) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()].map(([file, n]) => ({ file, signature: `Access-Control-Allow-Origin x${n}` }));
}

export function formatRows(rows: InventoryRow[]): string[] {
  return rows.map((r) => `${r.file} | ${r.signature}`).sort();
}
