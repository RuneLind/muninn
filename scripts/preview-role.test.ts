import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewRoleEnv, previewRootProblem, readRoleKeys, type PreviewRoleOptions } from "./preview-role.ts";

const base: PreviewRoleOptions = {
  role: "fag",
  wiki: "melosys-felles",
  root: "/wikis/felles",
  roleKeys: ["fag", "utvikler"],
  port: 3013,
  botsDir: "/tmp/bots",
};

describe("previewRoleEnv", () => {
  test("the viewer's ident is the role's synthetic member, and every key gets one", () => {
    const env = previewRoleEnv(base);
    expect(env.MUNINN_LOCAL_IDENT).toBe("X900001");
    expect(env.WIKI_ANSWER_GROUPS).toBe("fag=X900001;utvikler=X900002");
    expect(previewRoleEnv({ ...base, role: "utvikler" }).MUNINN_LOCAL_IDENT).toBe("X900002");
  });

  test("an unknown role throws, naming the keys", () => {
    expect(() => previewRoleEnv({ ...base, role: "jus" })).toThrow(/roleKeys are fag, utvikler/);
  });

  test("it never shares the dev instance's log file or its research MCP port", () => {
    const env = previewRoleEnv(base);
    expect(env.LOG_DIR).toBe("none");
    expect(env.RESEARCH_MCP_PORT).toBe("0");
  });

  test("the default lens is set only when asked, so the wiki's own defaultLens holds", () => {
    expect("WIKI_DEFAULT_LENS" in previewRoleEnv(base)).toBe(false);
    expect(previewRoleEnv({ ...base, lens: "overview" }).WIKI_DEFAULT_LENS).toBe("melosys-felles=overview");
  });
});

describe("readRoleKeys", () => {
  test("a .wiki-reader.json that is not JSON throws, naming the file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "preview-role-test-"));
    writeFileSync(path.join(root, ".wiki-reader.json"), "{ roleKeys: [", "utf8");
    expect(() => readRoleKeys(root)).toThrow(/\.wiki-reader\.json is not valid JSON/);
  });
});

describe("previewRootProblem", () => {
  test("a name or root that WIKI_EXTRA would split is refused", () => {
    expect(previewRootProblem("w", "/p/a=b")).toMatch(/"="/);
    expect(previewRootProblem("w,x", "/p/a")).toMatch(/","/);
    expect(previewRootProblem("w=x", "/p/a")).toMatch(/"="/);
    expect(previewRootProblem("melosys-felles", "/Users/x/melosys-kode-wiki")).toBeNull();
  });

  test("previewRoleEnv refuses such a root, so no caller can skip the check", () => {
    expect(() => previewRoleEnv({ ...base, root: "/p/a=b" })).toThrow(/"="/);
  });
});
