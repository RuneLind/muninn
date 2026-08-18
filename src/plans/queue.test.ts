import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  mergeQueueOrder,
  parseQueueYaml,
  serializeQueue,
  QUEUE_COLUMNS,
  type QueueOrder,
} from "./queue.ts";

const KNOWN = new Set(["a-plan", "b-plan", "c-plan"]);

describe("parseQueueYaml", () => {
  test("parses the canonical shape", () => {
    const { order, warnings } = parseQueueYaml(
      "proposed:\n  - a-plan\n  - b-plan\nready:\n  - c-plan\n",
      KNOWN,
    );
    expect(order).toEqual({ proposed: ["a-plan", "b-plan"], ready: ["c-plan"] });
    expect(warnings).toEqual([]);
  });

  test("an absent/empty file is every column unranked, not an error", () => {
    expect(parseQueueYaml("")).toEqual({ order: {}, warnings: [] });
    expect(parseQueueYaml("   \n")).toEqual({ order: {}, warnings: [] });
  });

  test("drops unknown columns", () => {
    const { order, warnings } = parseQueueYaml("shipped:\n  - a-plan\n", KNOWN);
    expect(order).toEqual({});
    expect(warnings.join()).toContain('unknown column "shipped"');
  });

  test("drops a non-list column and a non-string entry", () => {
    const { order, warnings } = parseQueueYaml(
      "proposed: nope\nready:\n  - a-plan\n  - 7\n",
      KNOWN,
    );
    expect(order).toEqual({ ready: ["a-plan"] });
    expect(warnings.some((w) => w.includes('"proposed" is not a list'))).toBe(true);
    expect(warnings.some((w) => w.includes("non-slug entry"))).toBe(true);
  });

  test("a non-string entry is named, so `- true` / `- ~` are attributable", () => {
    // The YAML shapes that reach this branch have no slug text to quote — the
    // parser hands over a boolean or a null. Without the value in the message a
    // reader cannot find the offending line in a hand-edited file.
    const { order, warnings } = parseQueueYaml("proposed:\n  - true\n  - ~\n  - a-plan\n", KNOWN);
    expect(order).toEqual({ proposed: ["a-plan"] });
    expect(warnings.some((w) => w.includes('"proposed"') && w.includes("true"))).toBe(true);
    expect(warnings.some((w) => w.includes('"proposed"') && w.includes("null"))).toBe(true);
  });

  test("drops a slug naming no plan on disk", () => {
    const { order, warnings } = parseQueueYaml("proposed:\n  - a-plan\n  - gone\n", KNOWN);
    expect(order).toEqual({ proposed: ["a-plan"] });
    expect(warnings.join()).toContain('"gone" names no plan on disk');
  });

  test("without a known-slug set, nothing is dropped for existence", () => {
    const { order } = parseQueueYaml("proposed:\n  - anything\n");
    expect(order).toEqual({ proposed: ["anything"] });
  });

  test("a slug in two columns keeps only the first", () => {
    const { order, warnings } = parseQueueYaml(
      "proposed:\n  - a-plan\nready:\n  - a-plan\n  - b-plan\n",
      KNOWN,
    );
    expect(order).toEqual({ proposed: ["a-plan"], ready: ["b-plan"] });
    expect(warnings.join()).toContain("more than one column");
    expect(warnings.join()).toContain('"proposed"');
    expect(warnings.join()).toContain('"ready"');
  });

  test("a slug twice in ONE column says so, rather than blaming two columns", () => {
    const { order, warnings } = parseQueueYaml(
      "ready:\n  - a-plan\n  - a-plan\n  - b-plan\n",
      KNOWN,
    );
    expect(order).toEqual({ ready: ["a-plan", "b-plan"] });
    expect(warnings.join()).toContain('twice in column "ready"');
    expect(warnings.join()).not.toContain("more than one column");
  });

  test("a duplicate top-level key cannot blank the board", () => {
    // `yaml`'s default uniqueKeys THROWS here, which would drop every column.
    const { order, warnings } = parseQueueYaml(
      "proposed:\n  - a-plan\nproposed:\n  - b-plan\nready:\n  - c-plan\n",
      KNOWN,
    );
    expect(order).toEqual({ proposed: ["b-plan"], ready: ["c-plan"] });
    expect(warnings.join()).toContain('duplicate column "proposed"');
  });

  test("an end-of-line comment is legal", () => {
    const { order, warnings } = parseQueueYaml("proposed:\n  - a-plan # next up\n", KNOWN);
    expect(order).toEqual({ proposed: ["a-plan"] });
    expect(warnings).toEqual([]);
  });

  test("a null document and a null column are 'unranked', not errors", () => {
    expect(parseQueueYaml("# only a comment\n")).toEqual({ order: {}, warnings: [] });
    const { order, warnings } = parseQueueYaml("proposed:\nready:\n  - a-plan\n", KNOWN);
    expect(order).toEqual({ ready: ["a-plan"] });
    expect(warnings).toEqual([]);
  });

  test("off-grammar slugs are dropped with a warning", () => {
    const { order, warnings } = parseQueueYaml(
      "proposed:\n  - 9lives\n  - has_underscore\n  - a.plan\n  - ok-plan\n",
    );
    expect(order).toEqual({ proposed: ["ok-plan"] });
    expect(warnings).toHaveLength(3);
    expect(warnings.join()).toContain("not a valid slug");
  });

  test("the YAML boolean/null literals are never slugs, quoted or not", () => {
    // Bare `true` parses as a boolean (a non-string entry); the QUOTED forms
    // reach the grammar as strings and must still be refused, because mimir's
    // parser cannot tell a quoted `true` from the literal on the way back in.
    const { order, warnings } = parseQueueYaml(
      'proposed:\n  - true\n  - "True"\n  - "null"\n  - ok-plan\n',
    );
    expect(order).toEqual({ proposed: ["ok-plan"] });
    expect(warnings).toHaveLength(3);
  });

  test("unparseable YAML degrades to unranked rather than throwing", () => {
    const { order, warnings } = parseQueueYaml("proposed:\n - a\n  - b\n\t- c\n", KNOWN);
    expect(order).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a non-mapping top level degrades", () => {
    const { order, warnings } = parseQueueYaml("- a-plan\n", KNOWN);
    expect(order).toEqual({});
    expect(warnings.join()).toContain("top level is not a mapping");
  });

  test("an explicit empty column yields no key (rule 2 on the read side too)", () => {
    const { order } = parseQueueYaml("proposed: []\nready:\n  - a-plan\n", KNOWN);
    expect(order).toEqual({ ready: ["a-plan"] });
    expect(Object.hasOwn(order, "proposed")).toBe(false);
  });
});

describe("serializeQueue", () => {
  test("emits the canonical bytes in column-enum order", () => {
    const out = serializeQueue({ ready: ["c-plan"], proposed: ["a-plan", "b-plan"] });
    expect(out).toBe("proposed:\n  - a-plan\n  - b-plan\nready:\n  - c-plan\n");
  });

  test("an emptied column emits NO key", () => {
    expect(serializeQueue({ proposed: [], ready: ["c-plan"] })).toBe("ready:\n  - c-plan\n");
    expect(serializeQueue({ proposed: [] })).toBe("");
    expect(serializeQueue({})).toBe("");
  });

  test("THROWS on a slug the shared grammar rejects, rather than quoting it", () => {
    // Quoting would emit a file mimir's parser drops on read — a silent
    // divergence between the two readers is worse than a loud writer failure.
    expect(() => serializeQueue({ proposed: ["a: b"] })).toThrow(/not a valid slug/);
    expect(() => serializeQueue({ proposed: ["9lives"] })).toThrow(/not a valid slug/);
    expect(() => serializeQueue({ proposed: ["true"] })).toThrow(/not a valid slug/);
  });

  test("round-trips through the parser", () => {
    const cases: QueueOrder[] = [
      {},
      { proposed: ["a-plan"] },
      { proposed: ["a-plan", "b-plan"], ready: ["c-plan"] },
      { "in-flight": ["a-plan"], blocked: ["b-plan"] },
    ];
    for (const order of cases) {
      expect(parseQueueYaml(serializeQueue(order)).order).toEqual(order);
    }
  });

  test("round-trips every column", () => {
    const order: QueueOrder = {};
    QUEUE_COLUMNS.forEach((col, i) => {
      order[col] = [`plan-${i}`];
    });
    expect(parseQueueYaml(serializeQueue(order)).order).toEqual(order);
  });
});

describe("mergeQueueOrder", () => {
  const disk: QueueOrder = { proposed: ["a-plan"], ready: ["b-plan"], blocked: ["c-plan"] };

  test("a posted column replaces it; every absent one is preserved", () => {
    expect(mergeQueueOrder(disk, { ready: ["b-plan"] }, ["ready"])).toEqual(disk);
    expect(mergeQueueOrder(disk, { ready: [] }, ["ready"])).toEqual({
      proposed: ["a-plan"],
      blocked: ["c-plan"],
    });
  });

  test("a slug the posted set claims is dropped from every preserved column", () => {
    const merged = mergeQueueOrder(disk, { ready: ["b-plan", "a-plan"] }, ["ready"]);
    expect(merged).toEqual({ ready: ["b-plan", "a-plan"], blocked: ["c-plan"] });
    expect(merged.proposed).toBeUndefined();
    // …and the result is a file that round-trips to itself, which a twice-ranked
    // slug would not (`parseQueueYaml` drops the later copy).
    expect(parseQueueYaml(serializeQueue(merged)).order).toEqual(merged);
  });

  test("a posted EMPTY array un-ranks exactly that column", () => {
    expect(mergeQueueOrder(disk, {}, ["ready"])).toEqual({
      proposed: ["a-plan"],
      blocked: ["c-plan"],
    });
  });

  test("posting every ranked column empty merges to nothing (⇒ the file is deleted)", () => {
    const merged = mergeQueueOrder(disk, {}, ["proposed", "ready", "blocked"]);
    expect(merged).toEqual({});
    expect(serializeQueue(merged)).toBe("");
  });

  test("an empty disk is just the posted order, in QUEUE_COLUMNS order", () => {
    const merged = mergeQueueOrder({}, { blocked: ["c-plan"], proposed: ["a-plan"] }, [
      "blocked",
      "proposed",
    ]);
    expect(Object.keys(merged)).toEqual(["proposed", "blocked"]);
  });
});

describe("the queue fixture mirrors mimir's own", () => {
  // muninn's copy is what makes the byte-shape assertions hermetic; mimir's is
  // what its strict parser is pinned against. A drift between them is a green
  // suite on both sides and a file neither writes the same way.
  const MIMIR_FIXTURE =
    "/Users/rune/source/private/mimir/scripts/plan-status/fixtures/queue.canonical.yaml";

  test("byte-identical to the checked-in copy, when mimir is on this host", async () => {
    const upstream = Bun.file(MIMIR_FIXTURE);
    if (!(await upstream.exists())) return; // not this machine — nothing to compare
    const ours = await Bun.file(
      path.join(import.meta.dir, "fixtures", "queue.canonical.yaml"),
    ).text();
    expect(await upstream.text()).toBe(ours);
  });
});
