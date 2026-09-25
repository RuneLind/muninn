import { describe, expect, test } from "bun:test";
import { parseTrackersConfig, trackerAdapter } from "./index.ts";
import { JIRA_DEFAULT_STATUS_MAP } from "./jira.ts";

function parse(raw: unknown): { configs: ReturnType<typeof parseTrackersConfig>; warns: string[] } {
  const warns: string[] = [];
  const configs = parseTrackersConfig(raw, (w) => warns.push(`${w.key}: ${w.reason}`));
  return { configs, warns };
}

describe("parseTrackersConfig", () => {
  test("absent ⇒ no tracker and no warning", () => {
    expect(parse(undefined)).toEqual({ configs: [], warns: [] });
  });

  test("a non-array block warns and yields no tracker", () => {
    const { configs, warns } = parse({ id: "jira" });
    expect(configs).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  test("a full entry normalizes projects and hosts and merges statusMap over the defaults", () => {
    const { configs, warns } = parse([
      {
        id: "jira",
        projects: ["demo", " DEMO "],
        hosts: ["Example.Invalid"],
        frontmatterKeys: ["issue"],
        planTitle: "plan",
        createdMarkers: ["created"],
        statusMap: { Ferdig: "done", "In Progress": "review" },
      },
    ]);
    expect(warns).toEqual([]);
    const c = configs[0]!;
    expect(c.projects).toEqual(["DEMO"]);
    expect(c.hosts).toEqual(["example.invalid"]);
    expect(c.statusMap.Ferdig).toBe("done");
    expect(c.statusMap["In Progress"]).toBe("review");
    expect(c.statusMap["To Do"]).toBe(JIRA_DEFAULT_STATUS_MAP["To Do"]!);
    expect(c.planTitle!.flags).toContain("i");
    expect(c.planTitle!.flags).toContain("u");
  });

  test("a bad FIELD warns and drops only itself", () => {
    const { configs, warns } = parse([
      {
        id: "jira",
        projects: ["DEMO", "not a prefix"],
        hosts: "example.invalid",
        planTitle: "(",
        statusMap: { Ferdig: "finished" },
      },
    ]);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.projects).toEqual(["DEMO"]);
    expect(configs[0]!.hosts).toEqual([]);
    expect(configs[0]!.planTitle).toBeNull();
    expect(configs[0]!.statusMap.Ferdig).toBeUndefined();
    expect(warns).toHaveLength(4);
  });

  test("an entry with no usable project, an unknown id, a duplicate or a non-object is dropped whole", () => {
    const { configs, warns } = parse([
      { id: "jira" },
      { id: "linear", projects: ["DEMO"] },
      "jira",
      { id: "jira", projects: ["DEMO"] },
      { id: "jira", projects: ["OTHER"] },
    ]);
    expect(configs.map((c) => c.projects)).toEqual([["DEMO"]]);
    expect(warns).toHaveLength(4);
  });

  test("trackerAdapter never reads the prototype", () => {
    expect(trackerAdapter("jira")?.label).toBe("Jira");
    expect(trackerAdapter("constructor")).toBeUndefined();
  });
});

describe("parseTrackersConfig, fix round 1", () => {
  const collect = (raw: unknown) => {
    const warns: { key: string; reason: string }[] = [];
    const configs = parseTrackersConfig(raw, (w) => warns.push(w));
    return { configs, warns };
  };

  test("a host that is not a bare hostname warns and drops alone", () => {
    const { configs, warns } = collect([
      { id: "jira", projects: ["DEMO"], hosts: ["https://example.invalid/", "example.invalid:8443", "Example.Invalid"] },
    ]);
    expect(configs[0]!.hosts).toEqual(["example.invalid:8443", "example.invalid"]);
    expect(warns.map((w) => w.key)).toEqual(["trackers[0].hosts[0]"]);
  });

  test("a bad projects ELEMENT drops alone; the entry survives", () => {
    const { configs, warns } = collect([{ id: "jira", projects: ["DEMO", 5] }]);
    expect(configs[0]!.projects).toEqual(["DEMO"]);
    expect(warns.map((w) => w.key)).toEqual(["trackers[0].projects[1]"]);
  });

  test("a scalar projects says it is not an array, then drops the entry", () => {
    const { configs, warns } = collect([{ id: "jira", projects: "DEMO" }]);
    expect(configs).toEqual([]);
    expect(warns[0]).toEqual({ key: "trackers[0].projects", reason: expect.stringContaining("is not an array") });
  });

  test("a one-letter project is refused — the mention scanner could never find its keys", () => {
    const { configs, warns } = collect([{ id: "jira", projects: ["D", "DEMO"] }]);
    expect(configs[0]!.projects).toEqual(["DEMO"]);
    expect(warns.map((w) => w.key)).toEqual(["trackers[0].projects[0]"]);
  });

  test("a non-array block names the key `trackers`", () => {
    expect(collect({ id: "jira" }).warns.map((w) => w.key)).toEqual(["trackers"]);
  });
});
