/**
 * The guard behind `ports.ts`. Run by `bun test`, NOT by Playwright — the whole
 * point is that it fails on a plain `bun run test`, before a suite ever runs and
 * long before anyone tries to reproduce a "flake".
 *
 * Three rules. The FIRST version of this file had only the first one, and review
 * showed it was inert against the exact path that produced the 3042 collision:
 * registry values were unique, but nothing stopped two SPEC FILES from asking for
 * the same name — and `wiki-start-cards` got its literal by being copied from
 * another wiki spec. So the load-bearing check is the second: one name, one file.
 */

import { describe, expect, it } from "bun:test";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { E2E_PORTS, RESERVED_PORTS, e2ePort } from "./ports.ts";

const E2E_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

/** Every `.ts` under `e2e/`, recursively — not just `*.spec.ts` at the top level.
 *  A boot helper shared by several specs, or a spec in a subdirectory, binds
 *  ports exactly like a spec does and must be held to the same rule. */
function e2eSources(dir = E2E_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    // `lstatSync`, not `statSync`: a broken symlink under `e2e/` made `statSync`
    // throw at module scope, which took all five checks down rather than one
    // (measured). A symlink is skipped outright — whatever it points at is
    // either already in the walk or outside `e2e/`.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (entry !== "node_modules") e2eSources(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = e2eSources()
  .filter((f) => path.basename(f) !== "ports.ts" && path.basename(f) !== "ports.test.ts")
  .map((f) => ({ rel: path.relative(E2E_DIR, f), text: readFileSync(f, "utf8") }));

describe("e2e port registry", () => {
  it("hands every spec process a port of its own", () => {
    const byPort = new Map<number, string[]>();
    for (const [name, port] of Object.entries(E2E_PORTS)) {
      byPort.set(port, [...(byPort.get(port) ?? []), name]);
    }
    const shared = [...byPort].filter(([, names]) => names.length > 1);
    // Named in the failure: "3042 is taken by both X and Y" is the whole
    // diagnosis, and it is what a bare `toHaveLength` would have withheld.
    expect(shared.map(([port, names]) => `${port}: ${names.join(" + ")}`)).toEqual([]);
  });

  it("gives each registry name to exactly ONE file — the check the 3042 collision needed", () => {
    // Uniqueness of the VALUES cannot see this: two files that both call
    // `e2ePort("wiki-refresh")` bind the same port with a perfectly valid
    // registry. Verified by mutation that the value check alone stays green.
    const users = new Map<string, string[]>();
    for (const { rel, text } of SOURCES) {
      for (const m of text.matchAll(/e2ePort\(\s*["']([^"']+)["']\s*\)/g)) {
        const name = m[1]!;
        const seen = users.get(name) ?? [];
        if (!seen.includes(rel)) users.set(name, [...seen, rel]);
      }
    }
    const doubled = [...users].filter(([, files]) => files.length > 1);
    expect(doubled.map(([name, files]) => `${name}: ${files.join(" + ")}`)).toEqual([]);

    // And nothing may ask for a name the registry does not define — `e2ePort` is
    // typed, but a spec could still be reading a stale name from a rebase.
    const unknown = [...users.keys()].filter((n) => !(n in E2E_PORTS));
    expect(unknown).toEqual([]);

    // An entry nobody claims is a port silently reserved against nothing; it is
    // also how a rename leaves the old row behind for the next spec to collide
    // with.
    const unused = Object.keys(E2E_PORTS).filter((n) => !users.has(n));
    expect(unused).toEqual([]);
  });

  it("stays clear of the dev server, the shared Playwright server and the MCP ports", () => {
    const clash = Object.entries(E2E_PORTS).filter(([, p]) =>
      (RESERVED_PORTS as readonly number[]).includes(p),
    );
    expect(clash.map(([name, p]) => `${name} binds reserved ${p}`)).toEqual([]);
  });

  it("leaves no bare port literal anywhere under e2e/ — the registry is the only source", () => {
    // Detect by CONTEXT, not by numeric range. The range heuristic this replaced
    // was wrong in both directions: it missed every port outside 30xx/31xx/91xx
    // (`8080`, `8799`, `3200`) and it would have flagged ordinary durations passed
    // as call arguments (`waitForTimeout(3000)`, `setTimeout(fn, 3100)`,
    // `slice(0, 3000)`) the first time one appeared — and a guard that cries wolf
    // is a guard someone deletes.
    const DETECTORS: Array<{ why: string; re: RegExp }> = [
      // `const PORT = 3025`, `const port = 3025`, `DASHBOARD_PORT: "3030"`.
      { why: "port-named binding", re: /\b\w*port\w*\s*[:=]\s*["'`]?(\d{2,5})\b/gi },
      // `"http://127.0.0.1:3021"`, `localhost:3011`, `[::1]:9190`.
      {
        why: "host:port literal",
        re: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g,
      },
      // A bare literal in muninn's own port space with no port-ish name to give
      // it away — `const HUGINN = 3029`, the shape that started this.
      { why: "bare port-space literal", re: /(?:^|[^\w.])(30\d\d|31\d\d|91\d\d)\b/g },
    ];
    // Two things in that space are NOT ports: a DURATION or a length, whether
    // bound to a name (`firstDelayMs: 3000`) or passed as an argument
    // (`waitForTimeout(3000)`). Excluded structurally by what precedes them,
    // never by an allowlist of values.
    const NOT_A_PORT = [
      /(?:ms|delay|timeout|duration|interval|budget|width|height|len|length|size|max|min)\w*\s*[:=]\s*$/i,
      // Deliberately NOT anchored with `[^)]*$`: `setTimeout(() => {}, 3100)`
      // has a `()` of its own between the call name and the number, so an
      // anchored form missed it (measured). Presence of the call in the window
      // is enough.
      /(?:waitForTimeout|setTimeout|setInterval|sleep|slice|substring|substr|repeat|padStart|padEnd)\s*\(/i,
    ];

    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      text.split("\n").forEach((line, i) => {
        const trimmed = line.trim();
        // A block-comment continuation or a line comment: prose, not a binding.
        if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        // Strip a line comment WITHOUT eating the `//` of a URL scheme — the
        // previous version truncated at `http://`, so every port inside a URL
        // was invisible while the comment above claimed it was covered.
        const code = line.replace(/(^|[^:])\/\/.*$/, "$1");
        for (const { why, re } of DETECTORS) {
          re.lastIndex = 0;
          for (const m of code.matchAll(re)) {
            const at = m.index + m[0].indexOf(m[1]!);
            const before = code.slice(Math.max(0, at - 40), at);
            if (NOT_A_PORT.some((x) => x.test(before))) continue;
            offenders.push(`${rel}:${i + 1} [${why}] ${trimmed}`);
            return;
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("resolves a name to its port", () => {
    expect(e2ePort("plans-write")).toBe(E2E_PORTS["plans-write"]);
  });
});
