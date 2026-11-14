/** The `/summaries/discover` page's CSS (server-rendered) and its client bundle. */

import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const discoverPageClientScript = makeBundledClientScript("discover-page-browser.ts", import.meta.dir);

export function discoverPageStyles(): string {
  return `
    .dsc-page { max-width: 1400px; margin: 0 auto; padding: 20px 24px 60px; }
    .dsc-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .dsc-head h2 { font-size: 18px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .dsc-sub { color: var(--text-muted); font-size: 13px; }
    .dsc-spacer { flex: 1; }
    .dsc-back { color: var(--accent-light); font-size: 13px; }
    .dsc-controls { display: flex; flex-wrap: wrap; gap: 16px; padding: 10px 0 14px; border-bottom: 1px solid var(--border-primary); margin-bottom: 18px; }
    .dsc-ctl { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-muted); }
    .dsc-ctl-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-soft); }
    .dsc-ctl select {
      font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 6px;
      background: var(--bg-panel); color: var(--text-primary); border: 1px solid var(--border-primary);
    }
    .dsc-error { margin: 0 0 14px; color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary)); }
    .dsc-empty { color: var(--text-soft); padding: 26px; text-align: center; border: 1px dashed var(--border-secondary); border-radius: 10px; font-size: 13px; }
    .dsc-empty a { color: var(--accent-light); }

    .dsc-shelf { margin-bottom: 30px; scroll-margin-top: 16px; border-radius: 10px; }
    .dsc-shelf.dsc-target { outline: 2px solid var(--accent); outline-offset: 6px; }
    .dsc-shelf-head { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
    .dsc-shelf-head img { width: 96px; aspect-ratio: 16/9; object-fit: cover; border-radius: 6px; background: var(--border-primary); }
    .dsc-shelf-head h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .dsc-shelf-head h3 a { color: var(--text-primary); text-decoration: none; }
    .dsc-shelf-head h3 a:hover { color: var(--accent-light); }
    .dsc-because { font-size: 12px; color: var(--text-soft); text-transform: uppercase; letter-spacing: .06em; }
    .dsc-meta { color: var(--text-soft); font-size: 12px; }
    .dsc-qs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .dsc-q { font-size: 11.5px; border: 1px dashed var(--border-secondary); border-radius: 4px; padding: 0 6px; color: var(--text-soft); }
    .dsc-row { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(240px, 260px); gap: 14px; overflow-x: auto; padding-bottom: 8px; scroll-snap-type: x mandatory; }
    .dsc-row > .dsc-empty { grid-column: 1 / -1; min-width: 240px; }

    .dsc-card { background: var(--bg-card); border: 1px solid var(--border-primary); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; cursor: pointer; scroll-snap-align: start; transition: border-color .15s; }
    .dsc-card:hover, .dsc-card.dsc-sel, .dsc-card:focus-visible { border-color: var(--accent); }
    .dsc-thumb { position: relative; aspect-ratio: 16/9; background: var(--border-primary); }
    .dsc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dsc-dur { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.8); color: #fff; font-size: 12px; padding: 1px 5px; border-radius: 4px; }
    .dsc-x { position: absolute; right: 6px; top: 6px; width: 26px; height: 26px; border-radius: 50%; border: 0; background: rgba(0,0,0,.7); color: #fff; cursor: pointer; opacity: 0; transition: opacity .15s; }
    .dsc-card:hover .dsc-x, .dsc-x:focus-visible { opacity: 1; }
    @media (hover: none) { .dsc-x { opacity: 1; } }
    .dsc-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .dsc-title { font-weight: 600; font-size: 14px; line-height: 1.3; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .dsc-why { color: var(--text-secondary); font-size: 12.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .dsc-score { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-soft); }
    .dsc-bar { width: 46px; height: 4px; background: var(--border-secondary); border-radius: 2px; overflow: hidden; }
    .dsc-bar i { display: block; height: 100%; background: var(--accent); }
    .dsc-actions { display: flex; gap: 6px; margin-top: auto; padding-top: 4px; flex-wrap: wrap; }
    .dsc-btn {
      font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; text-decoration: none;
      background: var(--bg-surface); color: var(--text-primary);
      border: 1px solid var(--border-secondary); border-radius: 6px; padding: 3px 9px;
    }
    .dsc-btn:hover:not([disabled]) { background: var(--bg-hover); }
    .dsc-btn.dsc-primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
    .dsc-btn.dsc-done { color: color-mix(in srgb, var(--status-success) 70%, var(--text-primary)); border-color: var(--status-success); background: transparent; }
    .dsc-btn[disabled] { cursor: default; opacity: .75; }

    .dsc-drawer-bg { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 50; }
    .dsc-drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(560px, 100%); overflow-y: auto; background: var(--bg-page); border-left: 1px solid var(--border-secondary); z-index: 51; padding: 14px; box-sizing: border-box; }
    .dsc-drawer[hidden], .dsc-drawer-bg[hidden] { display: none; }
    .dsc-close { float: right; margin-bottom: 8px; }
    .dsc-detail { clear: both; background: var(--bg-card); border: 1px solid var(--border-primary); border-radius: 12px; overflow: hidden; }
    .dsc-player { aspect-ratio: 16/9; position: relative; background: #000; }
    .dsc-player img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: .9; }
    .dsc-player iframe { width: 100%; height: 100%; border: 0; display: block; }
    .dsc-play { position: absolute; inset: 0; margin: auto; width: 74px; height: 52px; border-radius: 12px; border: 0; background: rgba(200,40,40,.92); color: #fff; font-size: 22px; cursor: pointer; }
    .dsc-detail-body { padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 12px; }
    .dsc-detail h3 { margin: 0; font-size: 17px; line-height: 1.3; color: var(--text-primary); }
    .dsc-stats { display: flex; flex-wrap: wrap; gap: 6px; }
    .dsc-stat { font-size: 12px; border: 1px solid var(--border-secondary); border-radius: 999px; padding: 2px 9px; color: var(--text-secondary); }
    .dsc-stat b { color: var(--text-primary); font-weight: 600; }
    .dsc-box { border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); padding: 8px 12px; border-radius: 0 8px 8px 0; font-size: 13.5px; color: var(--text-primary); }
    .dsc-lbl { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent-light); margin-bottom: 2px; }
    .dsc-from { font-size: 12px; color: var(--text-soft); }
    .dsc-from b { color: var(--text-secondary); font-weight: 500; }
    .dsc-detail h4 { margin: 0 0 4px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-soft); }
    .dsc-chapters { list-style: none; margin: 0; padding: 0; font-size: 13px; columns: 2; column-gap: 18px; color: var(--text-primary); }
    .dsc-chapters li { break-inside: avoid; padding: 1px 0; }
    .dsc-chapters span { color: var(--accent-light); font-variant-numeric: tabular-nums; margin-right: 6px; }
    .dsc-desc { font-size: 12.5px; color: var(--text-secondary); white-space: pre-line; max-height: 12em; overflow: auto; overflow-wrap: anywhere; }
    .dsc-note { font-size: 12.5px; color: var(--text-soft); font-style: italic; }
    .dsc-note.dsc-warn { font-style: normal; color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary)); }

    .dsc-toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--text-primary); color: var(--bg-page); padding: 8px 14px; border-radius: 8px; font-size: 13px; z-index: 60; max-width: calc(100% - 32px); }
    .dsc-toast[hidden] { display: none; }
    .dsc-toast button { margin-left: 10px; background: transparent; border: 1px solid currentColor; color: inherit; border-radius: 5px; cursor: pointer; padding: 1px 8px; font: inherit; }

    @media (max-width: 760px) {
      .dsc-page { padding: 16px 16px 60px; }
      .dsc-chapters { columns: 1; }
    }
  `;
}
