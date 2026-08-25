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
import { readdirSync, readFileSync, statSync } from "node:fs";
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
    if (statSync(full).isDirectory()) {
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
    // Any four-digit number in muninn's port space, in any position: a `const`
    // initialiser, a lowercase name, an object value, or interpolated into a URL
    // string. The first version matched only `const <NAME>PORT = NNNN` and let
    // `const port = 3025`, `const HUGINN = 3029` and
    // `"http://127.0.0.1:3021"` straight through (verified by mutation).
    // Two things in this range are NOT ports and must not be flagged, or the
    // guard gets muted the first time someone hits a false positive: a port
    // named in PROSE (`playwright.config.ts` (port 3011) — a comment is not a
    // binding) and a DURATION that happens to look like one
    // (`firstDelayMs: 3000`). Both are excluded structurally, by what precedes
    // the number, never by an allowlist of specific values.
    const PORTISH = /\b(?:30\d\d|31\d\d|91\d\d)\b/g;
    const DURATION_BINDING = /(?:ms|delay|timeout|duration|interval|budget|width|height)\w*\s*[:=]\s*$/i;
    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      text.split("\n").forEach((line, i) => {
        const trimmed = line.trim();
        // A block-comment continuation or a line comment: prose, not code.
        if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        const code = line.replace(/\/\/.*$/, "");
        for (const m of code.matchAll(PORTISH)) {
          const before = code.slice(Math.max(0, m.index - 32), m.index);
          if (DURATION_BINDING.test(before)) continue;
          offenders.push(`${rel}:${i + 1} ${trimmed}`);
          break;
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("resolves a name to its port", () => {
    expect(e2ePort("plans-write")).toBe(E2E_PORTS["plans-write"]);
  });
});
