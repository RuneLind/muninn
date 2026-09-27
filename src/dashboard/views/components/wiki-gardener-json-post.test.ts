import { test, expect, describe } from "bun:test";
import { gardenerClientScript } from "./wiki-gardener-client.ts";

/**
 * The client half of the gardener's JSON gate: the server answers 415 to any
 * write POST that is not `application/json`, so a call site that reverts to
 * `{ method: "POST" }` breaks its button in the browser with every server test
 * green. This reads the BUNDLE the page serves (all modules it pulls in, not
 * one source file) and requires every `fetch` that passes an init to send the
 * JSON content type.
 */

/** Top-level argument texts of every `fetch(...)` call. Skips string and
 *  template literals while matching parens; good enough for Bun's output. */
function fetchCalls(js: string): string[][] {
  const calls: string[][] = [];
  const re = /\bfetch\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let argStart = i;
    const args: string[] = [];
    while (i < js.length && depth > 0) {
      const ch = js[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        i += 1;
        while (i < js.length && js[i] !== ch) i += js[i] === "\\" ? 2 : 1;
      } else if (ch === "(" || ch === "{" || ch === "[") {
        depth += 1;
      } else if (ch === ")" || ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) args.push(js.slice(argStart, i).trim());
      } else if (ch === "," && depth === 1) {
        args.push(js.slice(argStart, i).trim());
        argStart = i + 1;
      }
      i += 1;
    }
    calls.push(args);
  }
  return calls;
}

const JSON_CT = /["']content-type["']\s*:\s*["']application\/json["']/i;

describe("gardener client: every write fetch sends application/json", () => {
  test("JSON_POST carries the JSON content type", async () => {
    const js = await gardenerClientScript();
    const decl = /\bJSON_POST\s*=\s*(\{[\s\S]*?\});/.exec(js);
    expect(decl).not.toBeNull();
    expect(decl![1]).toMatch(JSON_CT);
    expect(decl![1]).toMatch(/method:\s*"POST"/);
  });

  test("every fetch with an init passes JSON_POST or an init naming application/json", async () => {
    const calls = fetchCalls(await gardenerClientScript());
    const withInit = calls.filter((a) => a.length > 1);
    const wrong = withInit.filter(([url, init]) => {
      // `/api/watchers/:id/trigger` is not a gardener route; it is on the
      // server's JSON-gate allowlist (write-route-json-gate.test.ts).
      if (url!.includes('"/api/watchers/"')) return false;
      return init !== "JSON_POST" && !JSON_CT.test(init!);
    });
    expect(wrong.map((a) => a.join(", "))).toEqual([]);
    // Not vacuous: the gardener's bodyless verbs all go through fetch-with-init.
    const gardenerPosts = withInit.filter(([url]) => url!.includes("/api/wiki/gardener/") || url === "withBot(path)");
    expect(gardenerPosts.length).toBeGreaterThanOrEqual(7);
  });
});
