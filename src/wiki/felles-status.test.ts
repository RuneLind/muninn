import { describe, expect, test } from "bun:test";
import { parseFellesStatus } from "./felles-status.ts";

const page = (over: Record<string, unknown> = {}) => ({
  relPath: "plans/a.mdx",
  tilstand: "endret",
  endredeFiler: ["plans/a.mdx", "plans/a.data.json"],
  avslag: [],
  advarsler: [],
  ...over,
});
const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ "bøtte": "melosys-felles", sider: [page()], "foreldreløse": [], ...over });

describe("parseFellesStatus", () => {
  test("translates the script's shape and counts the changed pages", () => {
    const r = parseFellesStatus(
      status({
        sider: [
          page(),
          page({ relPath: "b.md", tilstand: "uendret", endredeFiler: [] }),
          page({ relPath: "[skjult sti: 1 funn]", tilstand: "avvist", endredeFiler: [], avslag: ["fnr"] }),
          page({ relPath: "c.md", tilstand: "mangler-lokalt", endredeFiler: [], advarsler: ["w"] }),
        ],
        "foreldreløse": ["old.md", "[skjult sti: x]"],
      }) + "\n",
    );
    expect(r).toEqual({
      ok: true,
      status: {
        bucket: "melosys-felles",
        changed: 1,
        pages: [
          { relPath: "plans/a.mdx", masked: false, state: "changed", changedFiles: ["plans/a.mdx", "plans/a.data.json"], refusals: [], warnings: [] },
          { relPath: "b.md", masked: false, state: "unchanged", changedFiles: [], refusals: [], warnings: [] },
          { relPath: "[skjult sti: 1 funn]", masked: true, state: "refused", changedFiles: [], refusals: ["fnr"], warnings: [] },
          { relPath: "c.md", masked: false, state: "missing-locally", changedFiles: [], refusals: [], warnings: ["w"] },
        ],
        orphans: [
          { path: "old.md", masked: false },
          { path: "[skjult sti: x]", masked: true },
        ],
      },
    });
  });

  test.each([
    ["not JSON", "OK plans/a.mdx"],
    ["empty", ""],
    ["an array", "[]"],
    ["two objects", status() + "\n" + status()],
    ["bøtte missing", JSON.stringify({ sider: [], "foreldreløse": [] })],
    ["sider not an array", status({ sider: {} })],
    ["foreldreløse with a number", status({ "foreldreløse": [1] })],
    ["unknown tilstand", status({ sider: [page({ tilstand: "changed" })] })],
    ["empty relPath", status({ sider: [page({ relPath: "" })] })],
    ["endredeFiler not strings", status({ sider: [page({ endredeFiler: [null] })] })],
    ["avslag missing", status({ sider: [page({ avslag: undefined })] })],
    ["a page that is null", status({ sider: [null] })],
  ])("refuses %s", (_label, out) => {
    expect(parseFellesStatus(out).ok).toBe(false);
  });
});
