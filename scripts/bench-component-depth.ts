/**
 * What `MAX_COMPONENT_DEPTH` costs. Replays a plan-shaped page (folds, a nested
 * Callout, CodeTabs, a table, fences) as 200 growing prefixes through
 * `formatWebHtml` — the chat's per-delta re-render — and prints the median of 7
 * rounds as ms per delta.
 *
 * `MAX_COMPONENT_DEPTH` is a module constant, so the A/B is: edit it in
 * `src/format/markdown-ast.ts`, run this, edit it back, run again — interleaved,
 * since a single ordered pair measures the machine as much as the cap.
 *
 *   bun scripts/bench-component-depth.ts
 */
import { formatWebHtml } from "../src/web/web-format.ts";

const sections: string[] = ["---", "title: A plan", "plan_status: proposed", "---", "", "# A plan", ""];
for (let s = 0; s < 12; s++) {
  sections.push(`## Section ${s}`, "");
  sections.push(`<Fold title="Section ${s}">`, "", `## Section ${s}`, "");
  sections.push(`Prose about section ${s} with **bold**, \`code\` and a [[Wikilink ${s}]].`, "");
  sections.push('<Callout tone="info" title="Note">', "", `Nested callout body ${s}.`, "", "</Callout>", "");
  sections.push("<CodeTabs>", '<Tab label="ts">', "```ts", `const x${s} = ${s};`, "```", "</Tab>",
    '<Tab label="sh">', "```sh", `echo ${s}`, "```", "</Tab>", "</CodeTabs>", "");
  sections.push("| a | b |", "|---|---|", `| ${s} | ${s * 2} |`, "");
  sections.push("</Fold>", "");
}
const page = sections.join("\n");
const lines = page.split("\n");
const STEPS = 200;
const prefixes = Array.from({ length: STEPS }, (_, i) =>
  lines.slice(0, Math.ceil(((i + 1) / STEPS) * lines.length)).join("\n"));

const round = () => {
  const t0 = Bun.nanoseconds();
  for (const p of prefixes) formatWebHtml(p);
  return (Bun.nanoseconds() - t0) / 1e6 / STEPS;
};
for (let i = 0; i < 3; i++) round(); // warm
const runs = Array.from({ length: 7 }, round).sort((a, b) => a - b);
console.log(`lines=${lines.length} bytes=${page.length} median=${runs[3]!.toFixed(4)} ms/delta  all=[${runs.map((r) => r.toFixed(4)).join(", ")}]`);
