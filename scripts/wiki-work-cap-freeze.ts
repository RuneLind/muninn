/**
 * Freezes the Work threads cards an older build draws with NO manual
 * boundaries, over the cap property test's seeded scenarios
 * (`wiki-rail-work-cap-gen.ts`), so the test can prove the boundary-free rail
 * is that build's byte for byte (plan D20).
 *
 *   git archive <rev> | tar -x -C <dir>
 *   bun scripts/wiki-work-cap-freeze.ts <dir> > src/dashboard/views/components/wiki-rail-work-cap.fixture.json
 *
 * One digest per scenario over four card lists: `openThreadCards` (the rail
 * without the Group control) and `openWorkCards` at Threads, Related and Areas.
 */

import { CAP_FIXTURE_SCENARIOS, CAP_FIXTURE_START, CAP_NOW, CAP_STOPS, CapRandom, capCardsDigest, nextCapScenario } from "../src/dashboard/views/components/wiki-rail-work-cap-gen.ts";

const root = process.argv[2];
if (!root) throw new Error("usage: bun scripts/wiki-work-cap-freeze.ts <checkout of the build to freeze>");
const rail = await import(`${root}/src/dashboard/views/components/wiki-rail-input.ts`);

const r = new CapRandom(CAP_FIXTURE_START);
const digests: string[] = [];
for (let i = 0; i < CAP_FIXTURE_SCENARIOS; i++) {
  const s = nextCapScenario(r);
  const { pages, work } = s.world;
  const lists: unknown[] = [rail.openThreadCards(work.threads, pages, s.filters, [], s.pin, CAP_NOW, pages, work.asOfMs)];
  CAP_STOPS.forEach((stop, k) => lists.push(rail.openWorkCards(work, pages, s.filters, [], s.pin, CAP_NOW, pages, { stop, evidence: s.evidence[k] }).cards));
  digests.push(capCardsDigest(lists.map(capCardsDigest)));
}
console.log(JSON.stringify({ start: CAP_FIXTURE_START, scenarios: CAP_FIXTURE_SCENARIOS, digests }));
