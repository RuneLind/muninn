import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../../test/temp-dir.ts";
import { runGit } from "../commit.ts";
import { TRACKED_MAP_WARNING, warnTrackedWorkMaps, workMapIsTracked } from "./tracked-map.ts";
import { WORK_MAP_FILE } from "./write.ts";

async function git(dir: string, ...args: string[]): Promise<void> {
  const r = await runGit(dir, ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A wiki root in a fresh git repo; the map committed when `tracked`, left on disk untracked otherwise. */
async function wikiRepo(tracked: boolean): Promise<string> {
  const dir = await testTempDir(path.join(tmpdir(), "work-map-tracked-"));
  await git(dir, "init", "-q");
  writeFileSync(path.join(dir, "index.md"), "# w\n");
  writeFileSync(path.join(dir, WORK_MAP_FILE), "{}\n");
  await git(dir, "add", tracked ? "-A" : "index.md");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function sink() {
  const said: { message: string; wiki: string }[] = [];
  return { said, warn: (message: string, props: { wiki: string }) => void said.push({ message, ...props }) };
}

describe("the tracked work map warning", () => {
  test("a tracked map on an organized wiki: one warning naming the wiki and the risk", async () => {
    const root = await wikiRepo(true);
    expect(await workMapIsTracked(root)).toBe(true);
    const { said, warn } = sink();
    expect(await warnTrackedWorkMaps(["Mimir"], [{ name: "mimir", root }], workMapIsTracked, warn)).toEqual(["mimir"]);
    expect(said).toEqual([{ message: TRACKED_MAP_WARNING, wiki: "mimir" }]);
    expect(TRACKED_MAP_WARNING).toContain("a second instance organizing the same wiki makes repo sync's push fail and block");
  });

  test("an untracked map on disk: nothing", async () => {
    const root = await wikiRepo(false);
    expect(await workMapIsTracked(root)).toBe(false);
    const { said, warn } = sink();
    expect(await warnTrackedWorkMaps(["mimir"], [{ name: "mimir", root }], workMapIsTracked, warn)).toEqual([]);
    expect(said).toEqual([]);
  });

  test("a wiki outside git, a missing root, a throwing check: nothing, and no throw", async () => {
    const plain = await testTempDir(path.join(tmpdir(), "work-map-nogit-"));
    writeFileSync(path.join(plain, WORK_MAP_FILE), "{}\n");
    expect(await workMapIsTracked(plain)).toBe(false);
    expect(await workMapIsTracked(path.join(plain, "missing"))).toBe(false);
    const { said, warn } = sink();
    const registry = [{ name: "plain", root: plain }, { name: "gone", root: path.join(plain, "missing") }, { name: "boom", root: "/x" }];
    const isTracked = (root: string) => (root === "/x" ? Promise.reject(new Error("spawn failed")) : workMapIsTracked(root));
    expect(await warnTrackedWorkMaps(["plain", "gone", "boom"], registry, isTracked, warn)).toEqual([]);
    expect(said).toEqual([]);
  });

  test("only the wikis passed are checked: a tracked map this instance does not organize says nothing", async () => {
    const root = await wikiRepo(true);
    const asked: string[] = [];
    const { said, warn } = sink();
    const isTracked = async (r: string) => (asked.push(r), workMapIsTracked(r));
    expect(await warnTrackedWorkMaps([], [{ name: "mimir", root }], isTracked, warn)).toEqual([]);
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });
});
