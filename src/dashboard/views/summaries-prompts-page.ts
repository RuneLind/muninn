import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escHtml } from "./components/escape.ts";
import type { PromptMatrix, PromptMatrixCell } from "../../summaries/prompt-matrix.ts";

/**
 * `/summaries/prompts` — what every capture combination sends the model.
 *
 * One table: capture sources down, summary kinds across, one cell per
 * combination listing the pieces that combination receives. Clicking a cell
 * opens a drawer under the table with the composed system prompt (tinted by the
 * piece that produced each span), the user-prompt skeleton, the closing-takeaway
 * check prompt, and where a per-bot override of that kind would live.
 *
 * SERVER-RENDERED, whole. Every drawer is in the HTML from the first byte and
 * the script only toggles `hidden`, which is what makes the page an honest
 * record: there is no fetch that could answer with something the table does not
 * say, and a reader with no JavaScript still has every prompt on the page.
 *
 * The payload is `buildPromptMatrix` (`src/summaries/prompt-matrix.ts`), which
 * calls the verticals' own prompt builders. Nothing here composes a prompt — a
 * page that re-spelled one would agree with itself forever while the captures
 * moved underneath it.
 */

/**
 * Every piece id the tint has a colour for, in the order the legend lists them.
 *
 * The `--tok-*` ramp, not the `--status-*` one it started on: these spans are
 * text on `--bg-inset`, and that is the exact pair the syntax-highlight ramp is
 * tuned for in BOTH themes (`shared-styles.ts`). The plain status colours read
 * fine on dark and failed AA on light — measured 2026-09-09 against
 * `--bg-inset` #eceef3: success 2.84:1, warning 2.74:1, cyan 3.17:1,
 * `--text-muted` 4.26:1, info 4.45:1. The ramp's worst case is 4.62:1 light and
 * 5.34:1 dark. Same six hues, so the legend still reads as the same vocabulary.
 */
const PIECE_TINTS: ReadonlyArray<{ id: string; label: string; color: string }> = [
  { id: "intro", label: "Intro", color: "var(--tok-fn)" },
  { id: "envelope", label: "Envelope", color: "var(--tok-com)" },
  { id: "structure", label: "Structure", color: "var(--tok-str)" },
  { id: "context", label: "Context", color: "var(--tok-typ)" },
  { id: "no-commentary", label: "No-commentary rule", color: "var(--tok-num)" },
  { id: "rider-windowed", label: "Rider", color: "var(--tok-kw)" },
  { id: "rider-auto-caption", label: "Rider", color: "var(--tok-kw)" },
  { id: "rider-language", label: "Rider", color: "var(--tok-kw)" },
  { id: "rider-enrichment", label: "Rider", color: "var(--tok-kw)" },
];

/** The tint rules, one per piece id — the page's whole colour vocabulary. */
function pieceStyles(): string {
  return PIECE_TINTS.map((t) => `.pm-piece-${t.id} { color: ${t.color}; }`).join("\n    ");
}

/** A stable, attribute-safe id for one cell's drawer. */
function drawerId(cell: PromptMatrixCell): string {
  return `pm-drawer-${cell.sourceId}--${cell.kindId ?? "nokind"}`;
}

function chipsHtml(chips: readonly string[]): string {
  return chips.map((c) => `<span class="pm-chip">${escHtml(c)}</span>`).join("");
}

/**
 * The composed system prompt, one `<span>` per piece.
 *
 * The spans come from the pieces the prompt was BUILT from, so a line's colour
 * is the piece that produced it by construction. Nothing here reads the finished
 * string.
 */
function tintedPromptHtml(cell: PromptMatrixCell): string {
  return cell.systemPieces
    .map((p) => `<span class="pm-piece pm-piece-${escHtml(p.id)}" data-piece="${escHtml(p.id)}">${escHtml(p.text)}</span>`)
    .join("");
}

function overrideHtml(cell: PromptMatrixCell): string {
  if (cell.override === null) {
    return `<p class="pm-note">This source has no kind picker, so no <code>captureSummary.&lt;id&gt;.md</code> file can override it.</p>`;
  }
  const state = cell.override.present
    ? `<span class="pm-badge pm-badge-on" data-override="present">present</span>`
    : `<span class="pm-badge pm-badge-off" data-override="absent">not present</span>`;
  return `<p class="pm-note">Per-bot override: <code class="pm-path">${escHtml(cell.override.path)}</code> ${state}</p>`;
}

function drawerHtml(cell: PromptMatrixCell): string {
  return `
      <section class="pm-drawer" id="${escHtml(drawerId(cell))}" data-source="${escHtml(cell.sourceId)}" data-kind="${escHtml(cell.kindId ?? "")}" hidden>
        <h3 class="pm-drawer-title">${escHtml(cell.sourceId)}${cell.kindLabel ? ` · ${escHtml(cell.kindLabel)}` : ""}</h3>
        ${overrideHtml(cell)}
        <h4 class="pm-h4">System prompt</h4>
        <pre class="pm-prompt pm-system">${tintedPromptHtml(cell)}</pre>
        <h4 class="pm-h4">User prompt <span class="pm-h4-note">— the run's own builder over the fixed placeholder input</span></h4>
        <pre class="pm-prompt">${escHtml(cell.userPrompt)}</pre>
        <h4 class="pm-h4">Closing-takeaway check <span class="pm-h4-note">— run after every summary pass</span></h4>
        <pre class="pm-prompt">${escHtml(cell.takeawayPrompt)}</pre>
      </section>`;
}

/**
 * The button's accessible NAME. Its visible content is a bag of chips, which
 * reads out as one long run of fragments with no subject — a screen-reader user
 * has no way to tell which combination they are opening.
 */
function cellLabel(cell: PromptMatrixCell): string {
  return `Open the ${cell.sourceId}/${cell.kindId ?? "no kind"} prompt`;
}

function cellHtml(cell: PromptMatrixCell, span: number): string {
  return `<td class="pm-cell"${span > 1 ? ` colspan="${span}"` : ""}>
            <button type="button" class="pm-cell-btn" data-drawer="${escHtml(drawerId(cell))}"
                    aria-label="${escHtml(cellLabel(cell))}"
                    aria-controls="${escHtml(drawerId(cell))}" aria-expanded="false">
              ${chipsHtml(cell.chips)}
            </button>
          </td>`;
}

export function renderSummariesPromptsPage(matrix: PromptMatrix): string {
  const kindCount = Math.max(1, matrix.kinds.length);
  const rows = matrix.rows
    .map((row) => {
      const cells = row.source.kinds
        ? row.cells.map((c) => cellHtml(c, 1)).join("\n          ")
        : cellHtml(row.cells[0]!, kindCount);
      // ONE wording, because every row has an axis to name. The alternative that
      // used to live here — "nothing — this prompt has no branch" — was false
      // exactly where it fired: the two short-video SYSTEM prompts have no
      // branch, but both user builders branch on an empty transcript and on an
      // empty frame list. `prompt-matrix.test.ts` pins that no list is empty.
      const fixed = `<span class="pm-fixed" data-fixed="${escHtml(row.source.id)}"><b>fixed:</b> ${row.source.fixedAxes
        .map(escHtml)
        .join(" · ")}</span>`;
      return `<tr data-source="${escHtml(row.source.id)}">
          <th scope="row" class="pm-source">
            <span class="pm-source-label">${escHtml(row.source.label)}</span>
            <span class="pm-source-medium">${escHtml(row.source.medium)}</span>
            ${fixed}
          </th>
          ${cells}
        </tr>`;
    })
    .join("\n        ");

  const drawers = matrix.rows.flatMap((r) => r.cells).map(drawerHtml).join("\n");

  const botOptions = matrix.bots
    .map(
      (b) =>
        `<option value="${escHtml(b.name)}"${b.name === matrix.botName ? " selected" : ""}>${escHtml(b.name)} · ${escHtml(b.connector)}</option>`,
    )
    .join("");

  const legend = PIECE_TINTS.filter((t, i) => PIECE_TINTS.findIndex((o) => o.label === t.label) === i)
    .map((t) => `<span class="pm-legend-item"><i class="pm-swatch pm-piece-${t.id}"></i>${escHtml(t.label)}</span>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>Muninn - Capture prompts</title>
  <style>
    ${SHARED_STYLES}

    .page-content { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .pm-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
    .pm-head h2 { font-size: 18px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .pm-sub { color: var(--text-muted); font-size: 13px; margin: 0 0 16px; }
    .pm-sub a { color: var(--accent-light); }

    .pm-botpick { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-muted); }
    .pm-botpick select {
      font-family: inherit; font-size: 13px; padding: 5px 8px; border-radius: 6px;
      background: var(--bg-panel); color: var(--text-primary);
      border: 1px solid var(--border-primary);
    }
    .pm-botpick noscript button { font-family: inherit; font-size: 13px; }

    .pm-table-wrap { overflow-x: auto; }
    table.pm-table { border-collapse: collapse; width: 100%; }
    .pm-caption { caption-side: top; text-align: left; font-size: 12px; color: var(--text-muted); padding: 0 0 8px; }
    .pm-table th, .pm-table td { border: 1px solid var(--border-primary); vertical-align: top; text-align: left; }
    .pm-table thead th {
      padding: 8px 10px; font-size: 12px; font-weight: 600; color: var(--text-soft);
      background: var(--bg-panel); white-space: nowrap;
    }
    .pm-source { padding: 10px; width: 168px; background: var(--bg-panel); }
    .pm-source-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .pm-source-medium { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-top: 2px; }
    .pm-fixed { display: block; font-size: 10.5px; line-height: 1.5; color: var(--text-muted); margin-top: 6px; overflow-wrap: anywhere; }
    .pm-fixed b { font-weight: 600; color: var(--text-soft); }
    .pm-cell { padding: 0; }
    .pm-cell-btn {
      display: block; width: 100%; text-align: left; padding: 9px 10px;
      background: transparent; border: 0; cursor: pointer; font-family: inherit;
    }
    .pm-cell-btn:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
    .pm-cell-btn[aria-expanded="true"] { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .pm-chip {
      display: inline-block; margin: 2px 4px 2px 0; padding: 1px 7px; border-radius: 9px;
      font-size: 10.5px; line-height: 1.7; white-space: nowrap;
      background: var(--tint-neutral); color: var(--text-soft);
    }

    .pm-legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 14px 0 0; font-size: 11.5px; color: var(--text-muted); }
    .pm-legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .pm-swatch { width: 10px; height: 10px; border-radius: 2px; background: currentColor; display: inline-block; }

    .pm-drawer {
      margin-top: 18px; padding: 16px; border-radius: 8px;
      background: var(--bg-panel); border: 1px solid var(--border-primary);
    }
    .pm-drawer[hidden] { display: none !important; }
    .pm-drawer-title { margin: 0 0 8px; font-size: 14px; color: var(--text-primary); }
    .pm-h4 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-soft); }
    .pm-h4-note { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--text-dim); }
    /* A bot dir is one unbreakable ~70-char token, and this sits OUTSIDE the
       table's own scroller — without this the whole document scrolled sideways
       at 390 px (measured 427 CSS px against a 390 viewport). overflow-wrap
       INHERITS, so either rule below carries the property on its own and each is
       redundant given the other; both are kept so a .pm-path moved out of a
       .pm-note keeps wrapping. Pinned in e2e/summaries-prompts.spec.ts. */
    .pm-note { margin: 0; font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
    .pm-path { font-size: 11.5px; color: var(--text-soft); overflow-wrap: anywhere; }
    .pm-badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .pm-badge-on { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
    /* --text-disabled on --tint-neutral measured 1.79:1 dark / 1.64:1 light —
       "not present" is a STATE the reader has to read, not decoration.
       --text-soft is 7.49:1 / 5.59:1 on the same fill. */
    .pm-badge-off { background: var(--tint-neutral); color: var(--text-soft); }

    .pm-prompt {
      margin: 0; padding: 12px; border-radius: 6px; overflow-x: auto;
      background: var(--bg-inset); border: 1px solid var(--border-subtle);
      font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
      color: var(--text-soft);
    }
    ${pieceStyles()}
  </style>
</head>
<body>
  ${renderNav("summaries")}
  <div class="page-content">
    <div class="pm-head">
      <h2>Capture prompts</h2>
      <form class="pm-botpick" method="get" action="/summaries/prompts">
        <label for="pmBot">Bot</label>
        <select id="pmBot" name="bot">${botOptions}</select>
        <noscript><button type="submit">Show</button></noscript>
      </form>
    </div>
    <p class="pm-sub">
      Every capture combination, as the model receives it — built by the same prompt builders the
      capture jobs call. Kinds are what <strong>${escHtml(matrix.botName)}</strong> offers.
      Every skeleton is built from ONE fixed input: a two-window placeholder transcript, two
      placeholder frames, one of them carrying a selection note. A real capture decides some of
      what these cells pin — each row's <strong>fixed:</strong> line says which axes this page
      chose for that source, and everything not listed there is the capture's own.
      <a href="/summaries">← Summaries</a>
    </p>

    <div class="pm-table-wrap">
      <table class="pm-table">
        <caption class="pm-caption">
          Capture sources down, summary kinds across — one cell per combination. Choosing a cell
          opens the prompts it sends, under the table.
        </caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            ${matrix.kinds.map((k) => `<th scope="col">${escHtml(k.label)}</th>`).join("\n            ")}
          </tr>
        </thead>
        <tbody>
        ${rows}
        </tbody>
      </table>
    </div>
    <p class="pm-legend">${legend}</p>

${drawers}
  </div>
  <script>
    (function () {
      var buttons = Array.prototype.slice.call(document.querySelectorAll('.pm-cell-btn'));
      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-drawer');
          var target = document.getElementById(id);
          var wasOpen = !target.hidden;
          document.querySelectorAll('.pm-drawer').forEach(function (d) { d.hidden = true; });
          buttons.forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
          if (!wasOpen) {
            target.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            target.scrollIntoView({ block: 'nearest' });
          }
        });
      });
      var pick = document.getElementById('pmBot');
      if (pick) pick.addEventListener('change', function () { pick.form.submit(); });
    })();
  </script>
</body>
</html>`;
}
