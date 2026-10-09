import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// D22: the agent-context fold names live twice — this repo's
// `fixtures/reader-shared.json` and plan-card's copy in the skills repo, whose
// `CURRENT_STATE_RE` reads them. The copies must not drift. CI has no skills
// repo, so the test skips there, and its name says why.

const OURS = path.join(import.meta.dir, "fixtures", "reader-shared.json");
const SKILLS = path.join(homedir(), ".claude", "skills", "plan-card", "fixtures", "reader-shared.json");
const present = existsSync(SKILLS);

describe("reader-shared.json (D22)", () => {
  test.skipIf(!present)(
    present ? "matches plan-card's copy in the skills repo" : `skipped: no skills copy at ${SKILLS} (CI has no skills repo)`,
    () => {
      expect(JSON.parse(readFileSync(SKILLS, "utf8"))).toEqual(JSON.parse(readFileSync(OURS, "utf8")));
    },
  );
});
