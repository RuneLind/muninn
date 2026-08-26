import { test, expect, describe } from "bun:test";
import { readFile } from "node:fs/promises";
import { $ } from "bun";
import {
  DISPOSITIONS,
  claimedIdBodyRows,
  claimedIdParamRows,
  corsRows,
  formatRows,
} from "./inventory.ts";

/**
 * Acceptance item 12 of the NAV-login plan.
 *
 * "§2's grep commands are re-run IN THEIR WIDENED FORM (which catches the two
 * `app.on("HEAD", ...)` routes) and match a checked-in fixture." No remembered
 * integer: the last two plan drafts both cited a count that had already gone
 * stale, and the narrow grep form silently dropped two routes that are a
 * 200/404 oracle over a colleague's saved reports.
 */
const FIXTURE = "src/auth/claimed-id-inventory.txt";

interface FixtureRow { file: string; signature: string; disposition: string; }

async function readFixture(): Promise<FixtureRow[]> {
  const text = await readFile(FIXTURE, "utf8");
  const rows: FixtureRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [body] = line.split("   #");
    const parts = body!.split("|").map((p) => p.trim());
    expect(parts.length, `fixture row is not <file> | <signature> | <disposition>: ${line}`).toBe(3);
    rows.push({ file: parts[0]!, signature: parts[1]!, disposition: parts[2]! });
  }
  return rows;
}

const key = (r: { file: string; signature: string }) => `${r.file} | ${r.signature}`;

describe("acceptance 12 - the claimed-id inventory is a command, not a number", () => {
  test("the fixture and the source agree, row for row", async () => {
    const derived = formatRows([
      ...(await claimedIdParamRows()),
      ...(await claimedIdBodyRows()),
      ...(await corsRows()),
    ]);
    const fixture = (await readFixture()).map(key).sort();

    // Named diffs rather than a bare inequality: the failure a reader gets is
    // "this route is not in the fixture", which is the work to do.
    const missing = derived.filter((d) => !fixture.includes(d));
    const stale = fixture.filter((f) => !derived.includes(f));
    expect(missing, `sites in the source with no disposition in ${FIXTURE}`).toEqual([]);
    expect(stale, `rows in ${FIXTURE} that no longer exist in the source`).toEqual([]);
  });

  test("every row carries a disposition from the known vocabulary", async () => {
    for (const row of await readFixture()) {
      expect(DISPOSITIONS as readonly string[], `${key(row)}`).toContain(row.disposition);
    }
  });

  test("the WIDENED grep is what catches the two app.on(\"HEAD\") routes", async () => {
    // The narrow form (`app.<verb>("<path>`) returns a set that LOOKS complete
    // and silently drops these two, because their path is the second argument.
    const rows = (await claimedIdParamRows()).map(key);
    expect(rows).toContain('src/chat/routes.ts | HEAD /reports/:botName/:userId/:issueKey');
    expect(rows).toContain('src/chat/routes.ts | HEAD /specs/:botName/:userId/:issueKey');
  });

  test("no route file sets Access-Control-Allow-Origin by hand any more", async () => {
    // The disposition is one helper (`src/auth/cors.ts`), so a NEW wildcard
    // literal anywhere in `src/` outside it is a regression. This is the half
    // of acceptance 10 a runtime test cannot reach: it catches the site that
    // was added but never exercised.
    const out = await $`grep -rn "Access-Control-Allow-Origin" src/`.nothrow().text();
    const wildcards = out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .filter((l) => /"Access-Control-Allow-Origin"\s*[,:]\s*"\*"/.test(l))
      .filter((l) => !l.startsWith("src/auth/"));
    expect(wildcards, "a raw wildcard CORS header outside src/auth/cors.ts").toEqual([]);
  });
});
