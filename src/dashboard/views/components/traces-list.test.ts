import { test, expect } from "bun:test";
import vm from "node:vm";
import { helpersClientScript } from "./helpers-client.ts";
import { tracesListScript } from "./traces-list.ts";

/**
 * The traces list builds its rows as an innerHTML string from stored values: a
 * Telegram user with no @handle is stored under their first_name, so a name like
 * `<img src=x onerror=…>` ran script on /traces. Runs the page's own
 * renderTraceList in a vm and checks the markup it writes.
 */
async function render(traces: unknown[]): Promise<string> {
  const tbody = { innerHTML: "" };
  const ctx: Record<string, unknown> = {
    window: {},
    console,
    document: {
      getElementById: (id: string) => (id === "traceList" ? tbody : { innerHTML: "" }),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${await helpersClientScript()}\n${tracesListScript()}`, ctx);
  (ctx.renderTraceList as (t: unknown[]) => void)(traces);
  return tbody.innerHTML;
}

const base = { traceId: "t1", name: "chat", botName: "jarvis", startedAt: Date.now(), durationMs: 1200, status: "ok", attributes: {} };

test("a hostile username renders as text, not an element", async () => {
  const html = await render([{ ...base, username: "<img src=x onerror=alert(1)>" }]);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("hostile trace id, status and attribute counts are escaped too", async () => {
  const html = await render([{
    ...base,
    traceId: `x');alert(1);('"><b>`,
    status: `ok"><i>`,
    attributes: { modelErrors: `"><u>`, inputTokens: "<q>" },
  }, { ...base, traceId: "t3", attributes: { quietSkips: `"><em>` } }]);
  for (const tag of ["<b>", "<i>", "<u>", "<q>", "<em>"]) expect(html).not.toContain(tag);
  // The row's handler reads the id from the dataset rather than compiling it in.
  expect(html).toContain('onclick="loadWaterfall(this.dataset.trace)"');
  expect(html).toContain('data-trace="x&#39;);alert(1);(&#39;&quot;&gt;&lt;b&gt;"');
});

test("an ordinary row still names its user", async () => {
  const html = await render([{ ...base, username: "Rune" }, { ...base, traceId: "t2", userId: "u-7" }]);
  expect(html).toContain("<td>Rune</td>");
  expect(html).toContain("<td>u-7</td>");
});
