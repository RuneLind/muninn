/**
 * The guard behind `ports.ts`. Run by `bun test`, NOT by Playwright — the whole
 * point is that it fails on a plain `bun run test`, before a suite ever runs and
 * long before anyone tries to reproduce a "flake".
 *
 * Two rules, and the second is the load-bearing one: uniqueness alone would not
 * have caught the 3042 collision, because both specs wrote their own literal and
 * neither consulted a registry.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { E2E_PORTS, RESERVED_PORTS, e2ePort } from "./ports.ts";

const E2E_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

describe("e2e port registry", () => {
  it("hands every spec process a port of its own", () => {
    const entries = Object.entries(E2E_PORTS);
    const byPort = new Map<number, string[]>();
    for (const [name, port] of entries) {
      byPort.set(port, [...(byPort.get(port) ?? []), name]);
    }
    const shared = [...byPort].filter(([, names]) => names.length > 1);
    // Named in the failure: "3042 is taken by both X and Y" is the whole
    // diagnosis, and it is what a bare `toHaveLength` would have withheld.
    expect(shared.map(([port, names]) => `${port}: ${names.join(" + ")}`)).toEqual([]);
  });

  it("stays clear of the dev server and the shared Playwright server", () => {
    const clash = Object.entries(E2E_PORTS).filter(([, p]) =>
      (RESERVED_PORTS as readonly number[]).includes(p),
    );
    expect(clash.map(([name, p]) => `${name} binds reserved ${p}`)).toEqual([]);
  });

  it("leaves no bare port literal in a spec — the registry is the only source", () => {
    // A spec assigns its port ONCE, as `const PORT = e2ePort("…")`. A four-digit
    // literal on a `const <NAME>PORT =` line is the shape that drifted; anything
    // else in a spec (a timeout, a fixture number) is not a port declaration and
    // is deliberately not matched.
    const offenders: string[] = [];
    for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"))) {
      const text = readFileSync(path.join(E2E_DIR, file), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/^\s*(?:const|let)\s+\w*PORT\w*\s*(?::\s*number\s*)?=\s*\d{4}\b/.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("resolves a name to its port", () => {
    expect(e2ePort("plans-write")).toBe(E2E_PORTS["plans-write"]);
  });
});
