import { describe, expect, test } from "bun:test";
import { MAX_DATA_OBJECT_BYTES, MAX_OBJECT_BYTES, maxObjectBytesFor, validateMirrorRelPath } from "./bucket-mirror.ts";
import { pageFileExtension } from "../format/query-block.ts";

describe("bucket mirror: <Diagram> files", () => {
  test("admits the three archify json suffixes, under the data cap", () => {
    for (const rel of ["flows/x.architecture.json", "flows/x.workflow.json", "x.LIFECYCLE.json"]) {
      expect(validateMirrorRelPath(rel)).toEqual({ relPath: rel });
      expect(maxObjectBytesFor(rel)).toBe(MAX_DATA_OBJECT_BYTES);
    }
  });

  test("refuses a bare .json, and one whose archify suffix is the whole name", () => {
    expect("refused" in validateMirrorRelPath("flows/x.json")).toBe(true);
    expect("refused" in validateMirrorRelPath("flows/package.json")).toBe(true);
    expect(pageFileExtension("flows/.architecture.json")).toBe(".json");
  });

  test("an html sibling stays a page, under the 2 MB page cap", () => {
    expect(validateMirrorRelPath("flows/x.html")).toEqual({ relPath: "flows/x.html" });
    expect(maxObjectBytesFor("flows/x.html")).toBe(MAX_OBJECT_BYTES);
    expect(MAX_OBJECT_BYTES).toBe(2 * 1024 * 1024);
  });
});
