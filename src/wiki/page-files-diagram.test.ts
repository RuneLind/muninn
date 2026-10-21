import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DIAGRAM_HTML_MAX_BYTES, loadPageFiles } from "./page-files.ts";
import { PAGE_FILE_MAX_BYTES } from "../format/query-block.ts";
import { checkDiagrams } from "./lint-diagram.ts";
import { checkPageText } from "./lint.ts";
import { testTempDir } from "../test/temp-dir.ts";

let base = "";
let root = "";
const PAGE = "flows/page.mdx";
const JSON_OK = JSON.stringify({ components: [{ id: "a", label: "A", type: "backend" }] });
const PICTURE = `<!doctype html><html><body><svg viewBox="0 0 1 1"><g data-node-id="a" class="c-backend"/></svg><script>1</script></body></html>`;
const tag = (src: string) => `<Diagram src="${src}" />`;
const load = (...srcs: string[]) => loadPageFiles(root, PAGE, srcs.map(tag).join("\n\n"));

beforeAll(async () => {
  base = await testTempDir(path.join(tmpdir(), "muninn-diagram-files-"));
  root = path.join(base, "wiki");
  await mkdir(path.join(root, "flows"), { recursive: true });
  await writeFile(path.join(root, "flows", "ok.architecture.json"), JSON_OK);
  await writeFile(path.join(root, "flows", "ok.html"), PICTURE);
  await writeFile(path.join(root, "flows", "lone.architecture.json"), JSON_OK);
  await writeFile(path.join(root, "flows", "two.architecture.json"), JSON_OK);
  await writeFile(path.join(root, "flows", "two.html"), "<svg></svg><svg></svg>");
  await writeFile(path.join(root, "flows", "big.architecture.json"), JSON_OK);
  await writeFile(path.join(root, "flows", "big.html"), `<svg>${" ".repeat(DIAGRAM_HTML_MAX_BYTES)}</svg>`);
  await writeFile(path.join(root, "flows", "dirty.architecture.json"), JSON_OK);
  await writeFile(path.join(root, "flows", "dirty.html"), `<svg><script/><rect onclick="x()" class="zz c-backend"/></svg>`);
  await writeFile(path.join(root, "flows", "bad.workflow.json"), "[]");
  await writeFile(path.join(root, "flows", "bad.html"), PICTURE);
  await writeFile(path.join(base, "outside.html"), PICTURE);
  await writeFile(path.join(root, "flows", "link.architecture.json"), JSON_OK);
  await symlink(path.join(base, "outside.html"), path.join(root, "flows", "link.html"));
  await writeFile(path.join(root, "flows", "plain.json"), JSON_OK);
  await writeFile(path.join(root, "flows", "nojson.html"), PICTURE);
  await writeFile(path.join(root, "flows", "huge.lifecycle.json"), `{"x":"${"a".repeat(PAGE_FILE_MAX_BYTES)}"}`);
  await writeFile(path.join(root, "flows", "huge.html"), PICTURE);
  // One sibling named by five refs: 1.9 MB each time it is counted, so five
  // counts (9.5 MB) overrun the 8 MB page budget and one count does not.
  for (const kind of ["architecture", "workflow", "lifecycle"]) await writeFile(path.join(root, "flows", `shared.${kind}.json`), JSON_OK);
  await writeFile(path.join(root, "flows", "shared.html"), `${PICTURE.replace("<script>1</script>", `<script>${" ".repeat(1900 * 1024)}</script>`)}`);
  await writeFile(path.join(root, "flows", "marked.architecture.json"), JSON_OK);
  await writeFile(path.join(root, "flows", "marked.html"), `<svg viewBox="0 0 1 1"><text>reserved __dgm-id__ text</text></svg>`);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("loadPageFiles: a <Diagram>'s html sibling", () => {
  test("reads the json and sanitizes the sibling's one svg", async () => {
    const r = (await load("./ok.architecture.json")).get("./ok.architecture.json");
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.text).toBe(JSON_OK);
    expect(r.svg?.svg).toContain('data-node-id="a"');
    expect(r.svg?.svg).not.toContain("script");
    expect(r.svg?.problem).toBeUndefined();
  });

  test("a missing sibling, two svgs, or a sibling over its cap each say so", async () => {
    const files = await load("./lone.architecture.json", "./two.architecture.json", "./big.architecture.json");
    const svg = (ref: string) => {
      const r = files.get(ref);
      return r?.ok ? r.svg : undefined;
    };
    expect(svg("./lone.architecture.json")?.problem).toBe("missing");
    expect(svg("./two.architecture.json")?.problem).toBe("unparsable");
    expect(svg("./big.architecture.json")?.problem).toBe("too-large");
  });

  test("one sibling named by several refs is read once and counted once against the page budget", async () => {
    const refs = ["./shared.architecture.json", "shared.architecture.json", "./shared.workflow.json", "./shared.lifecycle.json", "shared.lifecycle.json"];
    const files = await load(...refs);
    expect(refs.map((ref) => {
      const r = files.get(ref);
      return r?.ok ? (r.svg?.problem ?? "drawn") : r?.reason;
    })).toEqual(["drawn", "drawn", "drawn", "drawn", "drawn"]);
  });

  test("a picture holding the reserved id text says so, not unparsable", async () => {
    const r = (await load("./marked.architecture.json")).get("./marked.architecture.json");
    expect(r?.ok && r.svg?.problem).toBe("id-mark");
  });

  test("a symlink out of the root is missing, never read", async () => {
    const r = (await load("./link.architecture.json")).get("./link.architecture.json");
    expect(r?.ok && r.svg?.problem).toBe("missing");
  });

  test("a bare .json is not a page file", async () => {
    const r = (await load("./plain.json")).get("./plain.json");
    expect(r).toEqual({ ok: false, reason: "extension" });
  });
});

describe("diagram-svg lint", () => {
  const page = { relPath: PAGE };
  const lint = async (...srcs: string[]) => {
    const content = `# T\n\nprose\n\n${srcs.map(tag).join("\n\n")}\n`;
    return checkDiagrams(page, content, await loadPageFiles(root, PAGE, content));
  };

  test("a clean diagram has no finding", async () => {
    expect(await lint("./ok.architecture.json")).toEqual([]);
  });

  test("a missing sibling is one warning on the tag's line", async () => {
    const f = await lint("./lone.architecture.json");
    expect(f).toEqual([
      { check: "diagram-svg", relPath: PAGE, line: 5, message: '<Diagram src="./lone.architecture.json"> picture ./lone.html is missing; the reader shows the text form' },
    ]);
  });

  test("unknown drops are reported by set", async () => {
    const msgs = (await lint("./dirty.architecture.json")).map((x) => x.message);
    expect(msgs).toEqual([
      '<Diagram src="./dirty.architecture.json"> picture had elements the reader drops: script',
      '<Diagram src="./dirty.architecture.json"> picture had attributes the reader drops: onclick',
      '<Diagram src="./dirty.architecture.json"> picture has classes the reader does not style: zz',
    ]);
  });

  test("a picture holding the reserved id text is reported as that, not as unparsable", async () => {
    expect((await lint("./marked.architecture.json")).map((x) => x.message)).toEqual([
      '<Diagram src="./marked.architecture.json"> picture ./marked.html contains the reserved text __dgm-id__, which the reader uses for its own ids; the reader shows the text form',
    ]);
  });

  test("two diagram kinds sharing one picture are reported on each; one kind named twice is not", async () => {
    expect((await lint("./shared.architecture.json", "shared.architecture.json", "./shared.workflow.json")).map((x) => [x.line, x.message])).toEqual([
      [5, '<Diagram src="./shared.architecture.json"> shares picture ./shared.html with <Diagram src="./shared.workflow.json">; archify writes one picture per diagram file, so these blocks show the same drawing'],
      [7, '<Diagram src="shared.architecture.json"> shares picture shared.html with <Diagram src="./shared.workflow.json">; archify writes one picture per diagram file, so these blocks show the same drawing'],
      [9, '<Diagram src="./shared.workflow.json"> shares picture ./shared.html with <Diagram src="./shared.architecture.json">, <Diagram src="shared.architecture.json">; archify writes one picture per diagram file, so these blocks show the same drawing'],
    ]);
    expect(await lint("./ok.architecture.json", "ok.architecture.json")).toEqual([]);
  });

  test("a json that is not an object is reported", async () => {
    expect((await lint("./bad.workflow.json")).map((x) => x.message)).toEqual([
      '<Diagram src="./bad.workflow.json"> is not a JSON object; the reader shows one line instead of the diagram',
    ]);
  });

  test("a diagram file that did not load is reported, sibling or not", async () => {
    expect((await lint("./gone.architecture.json", "./nojson.architecture.json", "./huge.lifecycle.json")).map((x) => [x.line, x.message])).toEqual([
      [5, '<Diagram src="./gone.architecture.json"> file is missing or unreadable; the reader shows one line instead of the diagram'],
      [7, '<Diagram src="./nojson.architecture.json"> file is missing or unreadable; the reader shows one line instead of the diagram'],
      [9, '<Diagram src="./huge.lifecycle.json"> file is over its 1 MB cap; the reader shows one line instead of the diagram'],
    ]);
  });

  test("another component's file that did not load is not this check's", async () => {
    const content = `# T\n\n<Query id="Q-1" csv="gone.csv" />\n\n${tag("./ok.architecture.json")}\n`;
    expect(checkDiagrams(page, content, await loadPageFiles(root, PAGE, content))).toEqual([]);
  });

  test("a file that did not load is diagram-svg's finding alone in checkPageText", async () => {
    const content = `# T\n\n${tag("./gone.architecture.json")}\n`;
    const files = await loadPageFiles(root, PAGE, content);
    expect(checkPageText({ relPath: PAGE }, content, [], files).map((x) => x.check).filter((c) => !c.includes("tldr"))).toEqual(["diagram-svg"]);
  });

  test("runs in checkPageText on a .mdx page, so wiki-check reports it", async () => {
    const content = `# T\n\n${tag("./lone.architecture.json")}\n`;
    const files = await loadPageFiles(root, PAGE, content);
    expect(checkPageText({ relPath: PAGE }, content, [], files).filter((x) => x.check === "diagram-svg")).toHaveLength(1);
  });
});
