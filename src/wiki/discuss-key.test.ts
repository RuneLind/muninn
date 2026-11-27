import { describe, expect, test } from "bun:test";
import { discussTurnKey } from "./discuss-key.ts";
import type { TrackerConfig } from "./trackers/types.ts";

const jira = { id: "jira", projects: ["MELOSYS"], hosts: [], frontmatterKeys: [] } as unknown as TrackerConfig;
const cfg = { trackers: [jira], keys: [{ name: "case", pattern: "MEL-\\d+" }] };

describe("discussTurnKey", () => {
  test("the question's first key, of either kind", () => {
    expect(discussTurnKey({ question: "where else is MEL-1029036?" }, cfg)).toBe("MEL-1029036");
    expect(discussTurnKey({ question: "is MELOSYS-8351 done, and MEL-1029036?" }, cfg)).toBe("MELOSYS-8351");
    expect(discussTurnKey({ question: "MEL-1029036 or MELOSYS-8351?" }, cfg)).toBe("MEL-1029036");
  });

  test("the selection's when the question names none; none when neither does", () => {
    expect(discussTurnKey({ question: "where else?", selection: "The night route for MEL-700001 is held." }, cfg)).toBe("MEL-700001");
    expect(discussTurnKey({ question: "what does this mean?", selection: "No key here." }, cfg)).toBeNull();
    expect(discussTurnKey({ question: "where else is MEL-1?", selection: "MEL-2" }, cfg)).toBe("MEL-1");
  });

  test("a tracker key's place is where it stands whole, not inside a longer token (fix round 1, finding 4)", () => {
    expect(discussTurnKey({ question: "see XMELOSYS-8351, then MEL-5, then MELOSYS-8351" }, cfg)).toBe("MEL-5");
  });

  test("a whole key only, and a wiki with no key patterns gets none", () => {
    expect(discussTurnKey({ question: "is XMEL-1029036 a key?" }, cfg)).toBeNull();
    expect(discussTurnKey({ question: "where else is MEL-1029036?" }, { trackers: [], keys: [] })).toBeNull();
    expect(discussTurnKey({ question: "where else is MEL-1029036?" }, null)).toBeNull();
  });
});
