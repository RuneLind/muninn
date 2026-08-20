import { test, expect } from "bun:test";
import { renderModelsPage } from "./models-page.ts";

/**
 * `/models` renders its client half as JavaScript inside a TypeScript TEMPLATE
 * LITERAL, which `tsc` does not parse — so a quoting mistake in that string is
 * invisible to the typecheck AND to every unit test that only greps the output.
 *
 * That is not hypothetical. A note added on this page read
 * `'… a bot\\'s wikiDir'`: inside a template literal `\\'` is an escape FOR the
 * apostrophe, so the emitted JS was `'… a bot's wikiDir'` — an unterminated
 * string that took the WHOLE fourth script block with it. Every renderer in it
 * (Machine card, roles, wiki synthesis, pipeline rows, the poll) was dead in the
 * browser while the server happily returned 200 and the suite stayed green.
 *
 * So: parse every inline block. `new Function` compiles without executing, which
 * is exactly the check the browser performs before running any of it.
 */
test("every inline script on /models parses as JavaScript", async () => {
  const html = await renderModelsPage();
  const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1] as string,
  );
  // A guard on the guard: a regex that matched nothing would pass forever.
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  expect(blocks.join("").length).toBeGreaterThan(10_000);
  const failures: string[] = [];
  blocks.forEach((body, i) => {
    try {
      new Function(body);
    } catch (err) {
      failures.push(`block ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  expect(failures).toEqual([]);
});
