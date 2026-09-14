import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimum versions for the packages that carried a Critical or High finding in
 * the digest `melosys-muninn-q2` was running — measured 2026-09-14 with Docker
 * Scout against `sha256:f2d8719…f4231`: 38 npm findings across 13 packages, all
 * cleared by the commit that added this file.
 *
 * Why a test and not the lockfile alone: `bun.lock` is a result, not a promise.
 * Nothing in the repo stops a later `bun install` — after any `package.json`
 * edit — from resolving one of these back to a vulnerable version. Only `hono`
 * is a direct dependency with a floor of its own; the other twelve sit under
 * SDKs (`@slack/bolt`, `@modelcontextprotocol/sdk`, `@huggingface/transformers`)
 * that own their ranges, and `sharp` is held in place by an `overrides` entry
 * that is easy to drop in good faith. The check reads `bun.lock` as text, so it
 * measures the artifact the container actually builds from
 * (`bun install --frozen-lockfile`), not the developer's `node_modules`.
 *
 * ⚠️ This floor is TEMPORARY. The durable control belongs in NAV's build:
 * PR 2 of the plan adds a scan gate before deploy that sees the whole image —
 * OS packages, native libraries and npm — against a database that keeps getting
 * updated. A hand-written list here only sees what it was written for, and goes
 * stale the moment a new advisory lands. DELETE this file once that gate is live
 * in `navikt/melosys-muninn` and has been shown to fail on a known-vulnerable
 * fixture. Until then it is the only thing that catches a roll-back.
 *
 * Raising a number here is a perfectly good change — LOWERING one is what this
 * exists to stop. Add a package when a new fix has to be held until PR 2.
 */
const MINIMUM_VERSIONS: Record<string, string> = {
  // CVE-2026-44494/44487/44496/44488/44486 (1.16.0), 42264/44495 (1.15.2),
  // 42035/42033/42043 (1.15.1) — via @slack/bolt and @slack/web-api.
  axios: "1.16.0",
  // CVE-2026-41242 (Critical 9.4, 7.5.5), 48712 (7.6.1), 44291/44293/44290/44289
  // (7.5.6) — via @huggingface/transformers → onnxruntime-web.
  protobufjs: "7.6.1",
  // CVE-2026-59873 (Critical 9.2, 7.5.19), 73566 (7.5.21), 59874 (7.5.18),
  // 31802 (7.5.11), 29786 (7.5.10), 26960 (7.5.8) — via onnxruntime-node.
  tar: "7.5.21",
  // CVE-2026-76172/75975 (3.1.6) plus four older ones — via ajv, which comes
  // from @modelcontextprotocol/sdk.
  "fast-uri": "3.1.6",
  // CVE-2026-67214 (5.1.16), 73086 (5.1.11) — via @scalar/hono-api-reference.
  nanoid: "5.1.16",
  // CVE-2026-29045 (4.12.4), 54290 (4.12.25). The only direct dependency on the
  // list; `package.json` carries a floor too, and the two have to move together.
  hono: "4.12.25",
  // CVE-2026-69192 — via express-rate-limit, which pinned 10.0.1 exactly in 8.2.1.
  "ip-address": "10.3.1",
  // CVE-2026-30827 — via @modelcontextprotocol/sdk.
  "express-rate-limit": "8.2.2",
  // CVE-2026-4926 — via @slack/bolt and express' router.
  "path-to-regexp": "8.4.0",
  // CVE-2026-12143 — via axios and @slack/web-api.
  "form-data": "4.0.6",
  // CVE-2026-48779 — via @slack/socket-mode.
  ws: "8.21.0",
  // CVE-2026-29087 — via @modelcontextprotocol/sdk.
  "@hono/node-server": "1.19.10",
  // GHSA-rgj7-g3m4-5g8c (libheif, 0.35.4) and GHSA-f88m-g3jw-g9cj (libvips,
  // 0.35.0). Held by `overrides` because @huggingface/transformers asks for
  // ^0.34.5 in EVERY released version, 4.x included — drop the override and
  // sharp falls back to 0.34.5 with both findings back with it.
  sharp: "0.35.4",
};

/**
 * Compare two versions on major.minor.patch.
 *
 * Deliberately naive, and right to be: every value compared here is one
 * `bun install` already resolved, so a concrete released version rather than a
 * range. A full semver implementation would add prerelease rules none of these
 * packages use in the lockfile.
 */
export function meetsMinimum(found: string, required: string): boolean {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((d) => Number.parseInt(d, 10) || 0);
  const f = parts(found);
  const r = parts(required);
  for (let i = 0; i < 3; i++) {
    const a = f[i] ?? 0;
    const b = r[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Every version `bun.lock` resolved for `pkg`.
 *
 * Returns a LIST, not one hit: a lockfile can hold several copies of the same
 * package (different parents with incompatible ranges), and then every copy has
 * to clear the floor. The pattern is anchored on `"<name>@`, so `tar` does not
 * match `tar-stream`.
 */
export function lockedVersions(lock: string, pkg: string): string[] {
  const name = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = lock.matchAll(new RegExp(`"${name}@(\\d[^"]*)"`, "g"));
  return [...new Set([...hits].map((m) => m[1]!))];
}

describe("minimum versions for packages with known Critical/High findings", () => {
  const lock = readFileSync(join(import.meta.dir, "..", "..", "bun.lock"), "utf8");

  for (const [pkg, required] of Object.entries(MINIMUM_VERSIONS)) {
    test(`${pkg} >= ${required}`, () => {
      const found = lockedVersions(lock, pkg);
      // Require the package to BE there, even though "gone from the tree" is an
      // equally good outcome security-wise — that is how `adm-zip` was cleared
      // (it sat vendored inside @github/copilot, which copilot-sdk 1.0.13 no
      // longer pulls in). Without this, a typo in the key above would yield no
      // hits, no comparison and a green test that measures nothing. When a
      // package does leave for good, the right answer is to delete its row, not
      // to let the test go quiet.
      expect(found.length, `bun.lock has no ${pkg} — delete the row if it is gone for good`)
        .toBeGreaterThan(0);
      const tooOld = found.filter((v) => !meetsMinimum(v, required));
      expect(
        tooOld,
        `bun.lock has ${pkg}@${tooOld.join(", ")} below the ${required} floor`,
      ).toEqual([]);
    });
  }

  test("lockedVersions finds EVERY copy, not just the first", () => {
    // That is the whole reason it returns a list: a fixed top-level copy beside
    // a vulnerable nested one is exactly what a scanner reports, and a
    // find-first variant would wave it through. Measured against a synthetic
    // lockfile rather than the real one, which today holds no duplicate — a test
    // reading only the real file cannot tell the two implementations apart.
    const synthetic = `
      "tar": ["tar@7.5.22", "", {}, "sha512-x=="],
      "onnxruntime-node/tar": ["tar@7.5.7", "", {}, "sha512-y=="],
    `;
    expect(lockedVersions(synthetic, "tar").sort()).toEqual(["7.5.22", "7.5.7"]);
    expect(lockedVersions(synthetic, "tar").filter((v) => !meetsMinimum(v, "7.5.21"))).toEqual(["7.5.7"]);
    expect(lockedVersions(`"tar-stream": ["tar-stream@3.1.7", "", {}, "sha512-z=="],`, "tar")).toEqual([]);
  });

  test("meetsMinimum compares each component numerically", () => {
    expect(meetsMinimum("7.5.22", "7.5.21")).toBe(true);
    expect(meetsMinimum("7.5.21", "7.5.21")).toBe(true);
    expect(meetsMinimum("7.5.7", "7.5.21")).toBe(false); // 7 < 21, not a string compare
    expect(meetsMinimum("7.6.0", "7.5.21")).toBe(true);
    expect(meetsMinimum("10.7.0", "10.3.1")).toBe(true);
    expect(meetsMinimum("0.34.5", "0.35.4")).toBe(false);
    expect(meetsMinimum("4.13.7", "4.12.25")).toBe(true);
  });

  test("the hono floor in package.json tracks the floor here", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    const range: string = pkg.dependencies.hono;
    const lowest = range.replace(/^[\^~>=]+/, "");
    expect(meetsMinimum(lowest, MINIMUM_VERSIONS.hono!)).toBe(true);
  });

  test("overrides holds sharp above the range transformers asks for", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    // An exact version, not a range: `overrides` is the only thing standing
    // between us and 0.34.5, and a `^` here would let an upstream yank of the
    // 0.35.x line resolve back under the floor with nothing else changing.
    expect(pkg.overrides?.sharp).toBe(MINIMUM_VERSIONS.sharp);
  });
});
