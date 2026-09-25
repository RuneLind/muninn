import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetIssueFieldsCacheForTest,
  loadIssueFields,
  parseIssueUpdated,
  pickIssueFields,
} from "./jira-lookup.ts";
import { JIRA_ISSUES_COLLECTION, jiraKeyFromDocId } from "../../jira/retrieval.ts";

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

describe("PR 3 fix round 1", () => {
  test("S2: an out-of-range component is null, never a rolled-over instant", () => {
    for (const bad of [
      "2026-13-01T00:00:00.000+0100",
      "2026-00-10T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-02-30T12:00:00Z",
      "2026-02-29T12:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-02-30T25:61:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T12:60:00Z",
      "2026-01-01T12:00:60Z",
      "2026-01-01T12:00:00.000+9999",
      "2026-01-01T12:00:00.000+1401",
      "2026-01-01T12:00:00.000+0160",
    ]) {
      expect(parseIssueUpdated(bad)).toBeNull();
    }
    // The edges that ARE valid still parse.
    expect(parseIssueUpdated("2028-02-29T23:59:59Z")).toBe(Date.UTC(2028, 1, 29, 23, 59, 59));
    expect(parseIssueUpdated("2026-01-01T00:00:00+14:00")).toBe(Date.UTC(2025, 11, 31, 10, 0, 0));
    expect(parseIssueUpdated("2026-01-01T00:00:00-1200")).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
  });

  test("S4: a document's key is the composer's `jiraKeyFromDocId`, so both sides agree which keys huginn holds", () => {
    const ids = ["demo-5_x.md", "D-1_x.md", "DEMO-6.extra_y.md", "DEMO-7.md", "DEMO-8_z.md"];
    const m = pickIssueFields(ids.map((id) => ({ id, status: "S" })));
    const expected = ids.map((id) => jiraKeyFromDocId(JIRA_ISSUES_COLLECTION, id)).filter(Boolean);
    expect([...m.keys()].sort()).toEqual((expected as string[]).sort());
    expect([...m.keys()].sort()).toEqual(["DEMO-6", "DEMO-7", "DEMO-8"]);
  });

  test("S3: past the TTL a failed refetch serves the last good listing, without refetching again at once", async () => {
    const listing = { documents: [{ id: "DEMO-110_x.md", status: "Ferdig" }] };
    let calls = 0;
    let up = true;
    const fetchApi = async () => {
      calls++;
      if (!up) throw new Error("down");
      return listing;
    };
    expect((await loadIssueFields("http://s.test", fetchApi, 0))?.get("DEMO-110")?.status).toBe("Ferdig");
    up = false;
    const tenMinutes = 10 * 60_000;
    expect((await loadIssueFields("http://s.test", fetchApi, tenMinutes + 1))?.get("DEMO-110")?.status).toBe("Ferdig");
    expect((await loadIssueFields("http://s.test", fetchApi, tenMinutes + 2))?.get("DEMO-110")?.status).toBe("Ferdig");
    expect(calls).toBe(2);
  });
});
