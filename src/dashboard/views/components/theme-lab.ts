/**
 * Theme lab — sliders over the active theme, on the real pages.
 *
 * Opened from the ◐ menu ("Theme lab…"). The lab reads the active theme's
 * computed tokens, derives overrides from its sliders (`theme-lab-core.ts`)
 * and sets them as inline custom properties on <html>, which outrank every
 * `html[data-theme]` / `html[data-palette]` block. **Copy tokens** puts a
 * `tokens: { … }` block for `palettes.ts` on the clipboard; the lab itself
 * never writes a palette.
 *
 * State lives in localStorage `muninn-theme-lab`: whether the lab is open,
 * and one slider state per theme choice, so switching themes in the ◐ menu
 * swaps the sliders. Open, the lab re-applies on every page load; closed (×),
 * it applies nothing and keeps the saved sliders for next time.
 *
 * Every page carries only `themeLabStubScript()`. The lab itself
 * (`themeLabScript()`, ~22 KB) is served at `THEME_LAB_PATH` and loaded when
 * the reader opens it, or on a page load while it is open: a page with the lab
 * closed ships none of it (jira-page.test.ts holds pages to that).
 */

import { PALETTES, PALETTE_REQUIRED_TOKENS } from "./palettes.ts";
import { LAB_BG_TOKENS, LAB_FUNCTIONS, LAB_LADDER, LAB_TEXT_TOKENS, LAB_WEIGHTS } from "./theme-lab-core.ts";

export const THEME_LAB_KEY = "muninn-theme-lab";
export const THEME_LAB_OPEN_ID = "themeLabOpen";
export const THEME_LAB_PATH = "/theme-lab.js";

/**
 * The per-page half: defines `window.__themeLabOpen` (the ◐ menu calls it)
 * and loads the lab when it is opened, or at once when it was left open.
 * Left open, it first sets the overrides the lab last applied for this theme,
 * so the page does not paint the shipped theme while the lab loads. Opened
 * while loading, the opens queue; a failed load says so and can be retried.
 */
export function themeLabStubScript(): string {
  return `
  (function() {
    if (window.__themeLabStub) return;
    window.__themeLabStub = true;
    var root = document.documentElement, queue = null;
    function fail() {
      var t = document.createElement('div');
      t.className = 'theme-lab-toast'; t.setAttribute('role', 'status');
      t.textContent = 'Theme lab did not load. Try again from ◐.';
      t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:1300;padding:8px 12px;border-radius:8px;background:var(--bg-panel);color:var(--text-primary);border:1px solid var(--border-secondary);font:13px system-ui,sans-serif';
      document.body.appendChild(t);
      setTimeout(function() { t.remove(); }, 6000);
    }
    function withLab(cb) {
      if (window.__themeLabOpenNow) return cb();
      if (queue) { queue.push(cb); return; }
      queue = [cb];
      var s = document.createElement('script');
      s.src = '${THEME_LAB_PATH}';
      // A 200 that is not the lab (a login page) loads but defines nothing.
      s.onload = function() { var q = queue; queue = null; if (window.__themeLabOpenNow) q.forEach(function(f) { f(); }); else { s.remove(); fail(); } };
      s.onerror = function() { queue = null; s.remove(); fail(); };
      document.head.appendChild(s);
    }
    window.__themeLabOpen = function(focus) { withLab(function() { window.__themeLabOpenNow(focus === true); }); };
    try {
      var st = JSON.parse(localStorage.getItem('${THEME_LAB_KEY}') || '{}');
      if (st && st.open) {
        var key = root.dataset.palette || root.dataset.theme || 'system';
        if (key === 'system') key += window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? ':dark' : ':light';
        var a = st.applied;
        if (a && a.key === key && a.tokens) for (var n in a.tokens) root.style.setProperty(n, a.tokens[n]);
        withLab(function() { window.__themeLabOpenNow(false); });
      }
    } catch (e) {}
  })();`;
}

/** The ◐ menu entry that opens the lab. */
export function themeLabMenuItemHtml(): string {
  return `<div class="theme-menu-sep" role="separator"></div><button type="button" class="theme-menu-item" role="menuitem" id="${THEME_LAB_OPEN_ID}" data-theme-lab><span class="theme-menu-glyph" aria-hidden="true">⚗</span>Theme lab…</button>`;
}

const LAB_CSS = `
.theme-lab { position: fixed; right: 16px; bottom: 16px; z-index: 1300; width: 300px; max-height: calc(100vh - 32px); overflow: auto;
  background: var(--bg-panel); color: var(--text-secondary); border: 1px solid var(--border-secondary); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4); font: 13px/1.4 system-ui, -apple-system, sans-serif; }
.theme-lab.min .theme-lab-body { display: none; }
.theme-lab-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border-primary); position: sticky; top: 0; background: var(--bg-panel); }
.theme-lab.min .theme-lab-head { border-bottom: 0; }
.theme-lab-title { flex: 1; font-weight: 600; color: var(--text-primary); }
.theme-lab-head button { background: transparent; border: 0; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; }
.theme-lab-head button:hover { color: var(--text-primary); background: var(--bg-hover); }
.theme-lab-body { padding: 4px 10px 10px; }
.theme-lab h4 { margin: 10px 0 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
.theme-lab-row { display: grid; grid-template-columns: 74px 1fr 44px; align-items: center; gap: 6px; margin: 3px 0; }
.theme-lab-row input[type=range] { width: 100%; accent-color: var(--accent); }
.theme-lab-row output { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-primary); }
.theme-lab-row select { background: var(--bg-inset); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px; font: inherit; }
.theme-lab-meters { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.theme-lab-meters b { font-weight: 600; text-align: right; }
.theme-lab-meters .ok { color: var(--status-success); }
.theme-lab-meters .meh { color: var(--status-warning); }
.theme-lab-meters .bad { color: var(--status-error); }
.theme-lab-actions { display: flex; gap: 6px; margin-top: 10px; }
.theme-lab-actions button { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--text-primary); font: inherit; cursor: pointer; }
.theme-lab-actions button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.theme-lab-status { min-height: 1.4em; margin-top: 6px; font-size: 12px; color: var(--text-muted); }
`;

/** The sliders, in panel order: [state key, label, min, max, step, section]. */
const SLIDERS: [string, string, number, number, number, string][] = [
  ["bgL", "Lightness", 0, 100, 0.5, "Background"],
  ["bgH", "Hue", 0, 360, 1, "Background"],
  ["bgS", "Saturation", 0, 60, 0.5, "Background"],
  ["textL", "Lightness", 0, 100, 0.5, "Body text"],
  ["textS", "Saturation", 0, 40, 0.5, "Body text"],
  ["strongLift", "Lift", 0, 0.3, 0.01, "Bold"],
  ["chipLift", "Lift", -20, 20, 0.5, "Code chip"],
  ["chipEdge", "Edge %", 0, 40, 1, "Code chip"],
];

let labScript: string | undefined;

/** The lab itself, served at `THEME_LAB_PATH`. Built once: its inputs are static. */
export function themeLabScript(): string {
  return (labScript ??= buildThemeLabScript());
}

function buildThemeLabScript(): string {
  const order: Record<string, string[]> = {};
  const labels: Record<string, string> = { "system:light": "System (light)", "system:dark": "System (dark)", light: "Light", dark: "Dark" };
  for (const p of PALETTES) { order[p.id] = Object.keys(p.tokens); labels[p.id] = p.label; }
  const watched = [...new Set([...PALETTE_REQUIRED_TOKENS, ...Object.values(order).flat(), ...LAB_BG_TOKENS, ...LAB_TEXT_TOKENS])];
  return `
  (function() {
    if (window.__themeLab) return;
    window.__themeLab = true;
    var LAB_BG_TOKENS = ${JSON.stringify(LAB_BG_TOKENS)};
    var LAB_TEXT_TOKENS = ${JSON.stringify(LAB_TEXT_TOKENS)};
    var LAB_LADDER = ${JSON.stringify(LAB_LADDER)};
${LAB_FUNCTIONS.map((fn) => `    var ${fn.name} = ${fn.toString()};`).join("\n")}
    var KEY = '${THEME_LAB_KEY}';
    var WATCHED = ${JSON.stringify(watched)};
    var ORDER = ${JSON.stringify(order)};
    var LABELS = ${JSON.stringify(labels)};
    var REQUIRED = ${JSON.stringify(PALETTE_REQUIRED_TOKENS)};
    var SLIDERS = ${JSON.stringify(SLIDERS)};
    var WEIGHTS = ${JSON.stringify(LAB_WEIGHTS)};
    var root = document.documentElement;
    var applied = [], ref = null, state = null, panel = null, choice = null;

    function load() { try { var s = JSON.parse(localStorage.getItem(KEY) || '{}'); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; } }
    function save(patch) { var s = load(); for (var k in patch) s[k] = patch[k]; try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
    var scheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function currentChoice() { return root.dataset.palette || root.dataset.theme || 'system'; }
    // The key slider states are saved under, and the panel's label: System has one per OS scheme.
    function currentKey() { return labStateKey(currentChoice(), !!(scheme && scheme.matches)); }
    // Every watched token, not only this script's own: the stub may have set the saved ones.
    function clear() { WATCHED.concat(applied).forEach(function(n) { root.style.removeProperty(n); }); applied = []; }
    function readRef() {
      clear();
      var cs = getComputedStyle(root), out = {};
      WATCHED.forEach(function(n) { out[n] = cs.getPropertyValue(n).trim(); });
      return out;
    }
    function derived() { return labDerive(ref, state); }
    function apply() {
      clear();
      var d = derived();
      for (var n in d) { root.style.setProperty(n, d[n]); applied.push(n); }
      // What the stub sets on the next page load, before this script arrives.
      save({ applied: { key: choice, tokens: d } });
    }
    function merged() { var d = derived(), t = {}; for (var n in ref) t[n] = ref[n]; for (var m in d) t[m] = d[m]; return t; }
    function persist() { var s = load(); var states = s.states || {}; states[choice] = state; save({ states: states }); }
    function begin() {
      choice = currentKey();
      ref = readRef();
      var saved = (load().states || {})[choice];
      var init = labInitialState(ref);
      state = init;
      if (saved && typeof saved === 'object') for (var k in init) if (saved[k] !== undefined && typeof saved[k] === typeof init[k]) state[k] = saved[k];
      apply();
    }

    // Bold is oklch(from <context> …), which the lab cannot compute itself:
    // a probe paints it and one canvas pixel reads it back as sRGB.
    var cv = null;
    function painted(c) {
      if (!cv) cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1);
      var d = cv.getImageData(0, 0, 1, 1).data;
      return labHex(d[0], d[1], d[2]);
    }
    function boldInk() {
      var b = document.createElement('b');
      b.style.cssText = 'position:absolute;left:-9999px;color:oklch(from var(--text-secondary) calc(l + var(--strong-lift) * clamp(-1, (l - var(--strong-pivot)) * 1000, 1)) c h)';
      b.textContent = 'x';
      document.body.appendChild(b);
      var c = getComputedStyle(b).color;
      b.remove();
      return painted(c);
    }
    function meters() {
      var t = merged(), page = t['--bg-page'], card = t['--bg-card'];
      var body = labContrast(t['--text-secondary'], page);
      var lead = labContrast(boldInk(), page) / body;
      var chip = labHsl(t['--bg-code-inline']), pg = labHsl(page);
      var dL = chip && pg ? Math.abs(chip[2] - pg[2]) : 0;
      var issues = labLadderIssues(ref, t);
      var rows = [
        ['Body / page', body.toFixed(1) + ':1', body >= 7 ? 'ok' : body >= 4.5 ? 'meh' : 'bad'],
        ['Heading / page', labContrast(t['--text-primary'], page).toFixed(1) + ':1', ''],
        ['Muted / card', labContrast(t['--text-muted'], card).toFixed(2) + ':1', labContrast(t['--text-muted'], card) >= 4.5 ? 'ok' : 'bad'],
        ['Accent text / page', labContrast(t['--accent-light'], page).toFixed(2) + ':1', labContrast(t['--accent-light'], page) >= 4.5 ? 'ok' : 'bad'],
        ['Bold lead', lead.toFixed(2) + '×', lead >= 1.15 ? 'ok' : lead >= 1.05 ? 'meh' : 'bad'],
        ['Chip ΔL', dL.toFixed(1) + ' %', dL >= 6 ? 'ok' : dL >= 3 ? 'meh' : 'bad'],
        ['Ladder order', issues.length ? issues.join(', ') : 'ok', issues.length ? 'bad' : 'ok'],
      ];
      return rows.map(function(r) { return '<span>' + r[0] + '</span><b class="' + r[2] + '">' + r[1] + '</b>'; }).join('');
    }
    function fmt(v) { return String(Math.round(v * 100) / 100); }
    function render() {
      if (!panel) return;
      // innerHTML replaces every control: put focus back on the one that had it.
      var a = document.activeElement, keep = a && panel.contains(a) ? (a.getAttribute('data-key') ? '[data-key="' + a.getAttribute('data-key') + '"]' : a.getAttribute('data-lab') ? '[data-lab="' + a.getAttribute('data-lab') + '"]' : null) : null;
      var minimized = !!load().min;
      panel.classList.toggle('min', minimized);
      var html = '<div class="theme-lab-head"><span class="theme-lab-title">⚗ Theme lab — ' + (LABELS[choice] || choice) + '</span>'
        + '<button type="button" data-lab="min" title="' + (minimized ? 'Expand' : 'Minimize') + '" aria-label="' + (minimized ? 'Expand' : 'Minimize') + '">' + (minimized ? '▴' : '▾') + '</button>'
        + '<button type="button" data-lab="close" title="Close the lab (the theme returns to normal)" aria-label="Close">×</button></div><div class="theme-lab-body">';
      var section = '';
      SLIDERS.forEach(function(s) {
        if (s[5] !== section) { section = s[5]; html += '<h4>' + section + '</h4>'; }
        html += '<label class="theme-lab-row"><span>' + s[1] + '</span><input type="range" data-key="' + s[0] + '" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '" value="' + state[s[0]] + '"><output>' + fmt(state[s[0]]) + '</output></label>';
        if (s[0] === 'strongLift') {
          html += '<label class="theme-lab-row"><span>Weight</span><select data-key="strongWeight">' + WEIGHTS.map(function(w) { return '<option' + (w === state.strongWeight ? ' selected' : '') + '>' + w + '</option>'; }).join('') + '</select><span></span></label>';
        }
      });
      html += '<h4>Checks</h4><div class="theme-lab-meters" id="themeLabMeters">' + meters() + '</div>'
        + '<div class="theme-lab-actions"><button type="button" data-lab="reset">Reset</button><button type="button" class="primary" data-lab="copy">Copy tokens</button></div>'
        + '<div class="theme-lab-status" id="themeLabStatus" role="status"></div></div>';
      panel.innerHTML = html;
      var back = keep && panel.querySelector(keep);
      if (back) back.focus();
    }
    function status(msg) { var el = document.getElementById('themeLabStatus'); if (el) el.textContent = msg; }
    function exportText() {
      var s = state;
      var header = 'Theme lab ' + new Date().toISOString().slice(0, 10) + ', from ' + (LABELS[choice] || choice) + ': page L' + fmt(s.bgL) + ' H' + fmt(s.bgH) + ' S' + fmt(s.bgS)
        + ', body L' + fmt(s.textL) + ' S' + fmt(s.textS) + ', lift ' + fmt(s.strongLift) + ' ' + s.strongWeight + ', chip ' + fmt(s.chipLift) + ' edge ' + fmt(s.chipEdge) + ' %. Re-measure the contrast comments before merging.';
      return labExport(merged(), ORDER[choice] || [], REQUIRED, labChangedKeys(ref, derived()), header);
    }
    // focus: opened by the reader (◐ menu), not re-opened by a page load.
    function openLab(focus) {
      save({ open: true });
      if (!panel) {
        if (!document.getElementById('themeLabCss')) {
          var st = document.createElement('style'); st.id = 'themeLabCss'; st.textContent = ${JSON.stringify(LAB_CSS)};
          document.head.appendChild(st);
        }
        panel = document.createElement('section');
        panel.className = 'theme-lab'; panel.id = 'themeLab'; panel.setAttribute('aria-label', 'Theme lab');
        document.body.appendChild(panel);
        panel.addEventListener('input', function(e) {
          var k = e.target.getAttribute('data-key');
          if (!k) return;
          state[k] = e.target.tagName === 'SELECT' ? e.target.value : parseFloat(e.target.value);
          var out = e.target.nextElementSibling;
          if (out && out.tagName === 'OUTPUT') out.textContent = fmt(state[k]);
          apply(); persist();
          var m = document.getElementById('themeLabMeters'); if (m) m.innerHTML = meters();
        });
        panel.addEventListener('click', function(e) {
          var b = e.target.closest('[data-lab]');
          if (!b) return;
          var a = b.getAttribute('data-lab');
          if (a === 'close') closeLab();
          else if (a === 'min') { save({ min: !load().min }); render(); }
          else if (a === 'reset') {
            var s = load(); var states = s.states || {}; delete states[choice]; save({ states: states });
            state = labInitialState(ref); apply(); render(); status('Back to ' + (LABELS[choice] || choice) + ' as shipped.');
          }
          else if (a === 'copy') {
            var text = exportText(), n = (text.match(/^\\s+"--/gm) || []).length;
            var done = function() { status('Copied ' + n + ' tokens. Paste them over the tokens block in palettes.ts.'); };
            // No clipboard (plain http on a LAN name, a denied permission): show the block to copy by hand.
            var manual = function() {
              status('Clipboard blocked: copy the block below.');
              var ta = document.createElement('textarea');
              ta.readOnly = true; ta.value = text; ta.rows = 8; ta.style.cssText = 'width:100%;margin-top:6px;font:11px ui-monospace,monospace';
              document.getElementById('themeLabStatus').after(ta); ta.select();
            };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, manual);
            else manual();
          }
        });
      }
      begin();
      render();
      // The first slider, or ▴ when the panel is minimized and its sliders hidden.
      if (focus === true) { var first = panel.querySelector(load().min ? '[data-lab="min"]' : 'input[data-key]'); if (first) first.focus(); }
    }
    function closeLab() {
      save({ open: false, applied: null });
      clear();
      if (!panel) return;
      // Closed from inside the panel: focus goes back to ◐, not to <body>.
      var had = panel.contains(document.activeElement);
      panel.remove(); panel = null;
      var btn = document.getElementById('themeToggle');
      if (had && btn) btn.focus();
    }
    // The stub's window.__themeLabOpen calls this once the lab has loaded.
    window.__themeLabOpenNow = function(focus) {
      if (document.body) openLab(focus);
      else document.addEventListener('DOMContentLoaded', function() { openLab(focus); });
    };
    // A theme picked in the ◐ menu while the lab is open: start over from that theme.
    function follow() { if (panel && currentKey() !== choice) { begin(); render(); } }
    new MutationObserver(follow).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
    // Under System an OS scheme flip changes the reference without touching an attribute.
    if (scheme && scheme.addEventListener) scheme.addEventListener('change', follow);
  })();`;
}
