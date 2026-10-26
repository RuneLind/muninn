import { describe, expect, test } from "bun:test";
import { pythonHtml5Entities, renderHtmlEntitiesModule } from "../../scripts/gen-html-entities.ts";
import { namedEntity } from "./html-entities.ts";

const python = pythonHtml5Entities();

describe("the HTML5 named-reference table", () => {
  test("zero-width joiners: &zwnj; is U+200C, &zwj; U+200D", () => {
    expect(namedEntity("zwnj")).toBe("‌");
    expect(namedEntity("zwj")).toBe("‍");
    expect(namedEntity("NotNestedGreaterGreater")).toBe("⪢̸");
    expect(namedEntity("bogus")).toBeUndefined();
  });

  // python3 is on every CI runner; a machine without it skips only these two.
  test.skipIf(python === null)("every semicolon name decodes to Python's html.entities.html5 value", () => {
    const names = Object.keys(python!).filter((k) => k.endsWith(";"));
    expect(names.length).toBe(2125);
    const wrong = names.filter((k) => namedEntity(k.slice(0, -1)) !== python![k]);
    expect(wrong).toEqual([]);
  });

  test.skipIf(python === null)("the module is byte-identical to the generator's output", async () => {
    const onDisk = await Bun.file(new URL("./html-entities.ts", import.meta.url).pathname).text();
    expect(onDisk).toBe(renderHtmlEntitiesModule(python!));
  });
});
