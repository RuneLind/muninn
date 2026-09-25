import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetIssueFieldsCacheForTest,
  loadIssueFields,
  parseIssueUpdated,
  pickIssueFields,
} from "./jira-lookup.ts";

afterEach(() => __resetIssueFieldsCacheForTest());

describe("parseIssueUpdated", () => {
  test("reads both offset spellings to the same instant", () => {
    expect(parseIssueUpdated("2026-03-29T12:00:00.000+0200")).toBe(Date.UTC(2026, 2, 29, 10, 0, 0));
    expect(parseIssueUpdated("2026-03-29T12:00:00.000+02:00")).toBe(Date.UTC(2026, 2, 29, 10, 0, 0));
    expect(parseIssueUpdated("2026-03-29T12:00:00Z")).toBe(Date.UTC(2026, 2, 29, 12, 0, 0));
  });
  test("a stray `\\:` is read as `:`", () => {
    expect(parseIssueUpdated("2026-01-02T03\\:04\\:05.000+0100")).toBe(Date.UTC(2026, 0, 2, 2, 4, 5));
  });
  test("anything else is null", () => {
    for (const bad of ["", "yesterday", "2026-13", "2026-01-02 03:04", 42, null, undefined]) {
      expect(parseIssueUpdated(bad)).toBeNull();
    }
  });
});

describe("pickIssueFields", () => {
  test("the key is the id prefix before the first `_`", () => {
    const m = pickIssueFields([{ id: "DEMO-101_Some_summary.md", status: "Til Utvikle", title: "Some summary" }]);
    expect([...m.keys()]).toEqual(["DEMO-101"]);
    expect(m.get("DEMO-101")).toEqual({ status: "Til Utvikle", title: "Some summary" });
  });

  test("twins: the newest PARSED instant wins where a string comparison picks the other", () => {
    // 10:30+0200 is 08:30Z and 10:00+0100 is 09:00Z, so the string max is the older twin.
    const docs = [
      { id: "DEMO-102_old.md", status: "Til Utvikle", updated: "2026-03-29T10:30:00.000+0200" },
      { id: "DEMO-102_new.md", status: "Ferdig", updated: "2026-03-29T10:00:00.000+0100" },
    ];
    expect(["2026-03-29T10:30:00.000+0200", "2026-03-29T10:00:00.000+0100"].sort().at(-1)).toBe(
      "2026-03-29T10:30:00.000+0200",
    );
    expect(pickIssueFields(docs).get("DEMO-102")?.status).toBe("Ferdig");
    expect(pickIssueFields([...docs].reverse()).get("DEMO-102")?.status).toBe("Ferdig");
  });

  test("an unparseable `updated` loses to any that parses, and is not served", () => {
    const m = pickIssueFields([
      { id: "DEMO-103_a.md", status: "A", updated: "not a date" },
      { id: "DEMO-103_b.md", status: "B", updated: "2020-01-01T00:00:00.000+0000" },
    ]);
    expect(m.get("DEMO-103")?.status).toBe("B");
    const only = pickIssueFields([{ id: "DEMO-104_a.md", status: "A", updated: "not a date" }]);
    expect(only.get("DEMO-104")).toEqual({ status: "A" });
  });

  test("a tie goes to the lexically smaller id, whatever the listing order", () => {
    const at = "2026-01-01T00:00:00.000+0100";
    const a = { id: "DEMO-105_a.md", status: "A", updated: at };
    const b = { id: "DEMO-105_b.md", status: "B", updated: at };
    expect(pickIssueFields([a, b]).get("DEMO-105")?.status).toBe("A");
    expect(pickIssueFields([b, a]).get("DEMO-105")?.status).toBe("A");
  });

  test("an id with no key shape is skipped", () => {
    expect(pickIssueFields([{ id: "notes_about_things.md" }, { id: 7 }, null]).size).toBe(0);
  });
});

describe("loadIssueFields", () => {
  const listing = { documents: [{ id: "DEMO-110_x.md", status: "Ferdig" }] };

  test("reads ONLY the jira-issues collection, with include_issue_fields and nothing else", async () => {
    const paths: string[] = [];
    const m = await loadIssueFields("http://huginn.test", async (_url, p) => {
      paths.push(p);
      return listing;
    });
    expect(paths).toEqual(["/api/collection/jira-issues/documents?include_issue_fields=true"]);
    expect(m?.get("DEMO-110")?.status).toBe("Ferdig");
  });

  test("cached for its TTL; a failure is null and negatively cached", async () => {
    let calls = 0;
    const fetchApi = async () => {
      calls++;
      return listing;
    };
    await loadIssueFields("http://a.test", fetchApi, 1_000);
    await loadIssueFields("http://a.test", fetchApi, 2_000);
    expect(calls).toBe(1);

    let fails = 0;
    const failing = async () => {
      fails++;
      throw new Error("down");
    };
    expect(await loadIssueFields("http://b.test", failing, 1_000)).toBeNull();
    expect(await loadIssueFields("http://b.test", failing, 2_000)).toBeNull();
    expect(fails).toBe(1);
  });

  test("an EMPTY listing is a failure, not a corpus with no issues", async () => {
    expect(await loadIssueFields("http://c.test", async () => ({ documents: [] }))).toBeNull();
  });
});
