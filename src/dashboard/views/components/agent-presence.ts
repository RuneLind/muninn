/**
 * Agent presence chip — a tiny, embeddable "is a matching agent live (or about
 * to be)?" indicator (PR 4). Mounted on pages that already own their own SSE /
 * poll loops (`/wiki/gardener`, `/summaries`, `/wiki`), it stays cheap: a
 * standalone 15s poll of `GET /api/agents/overview` (NO second SSE connection),
 * filtered by `{ kinds?, bot? }`, always deep-linking to `/agents`.
 *
 * Three states (see {@link computePresence}):
 *   - `running`   — a matching non-completed run exists → pulsing dot + a short
 *                   "<Kind>: <phase> <done>/<total>" label + an "~Nm left" ETA
 *                   when the overview's `estimates` map has one for the run.
 *   - `preflight` — no running match, but a matching `upNext` entry fires within
 *                   {@link PRESENCE_HORIZON_MS} → amber "<Kind> starts in Nm".
 *   - `none`      — renders NOTHING (empty, hidden container; no placeholder).
 *
 * The pure model builder `computePresence` is DOM-free + unit-tested; the client
 * JS in `agentPresenceScript` is a hand-mirror of it (it lives inside a template
 * literal and cannot import) — keep the two in sync, exactly like the
 * `computeCardEta` mirror in `agents-page.ts`.
 */

import type { AgentKind } from "../../../observability/agent-status.ts";
import { estimateIdentity, fmtDurationShort } from "../../agent-eta.ts";

/** Show a preflight (pre-run) chip only for up-next entries firing within this
 *  horizon. An entry already past its slot ("due now") still qualifies. */
export const PRESENCE_HORIZON_MS = 60 * 60 * 1000;

export interface PresenceFilter {
  /** Kinds this chip cares about; unset ⇒ any kind. */
  kinds?: string[];
  /** Bot to scope to; unset ⇒ any bot. */
  bot?: string;
}

/** The subset of a live `AgentRun` the presence model reads. */
export interface PresenceRunLike {
  kind?: AgentKind;
  botName?: string;
  name?: string;
  phase?: string;
  startedAt: number;
  completed?: boolean;
  progress?: { done: number; total: number };
}

/** The subset of an `UpNextEntry` the presence model reads. */
export interface PresenceUpNextLike {
  kind: AgentKind;
  bot: string;
  name: string;
  nextRunAt: number;
  label?: string;
}

export type PresenceModel =
  | { state: "none" }
  | { state: "running"; kind: string; label: string; etaLabel?: string }
  | { state: "preflight"; kind: string; nextRunAt: number; label: string };

/** Short kind label for the chip (deliberately terser than the `/agents`
 *  `kindLabel` — a chip has less room). Mirror any change into the client JS. */
function kindShort(kind: string | undefined): string {
  switch (kind) {
    case "gardener_drain": return "Drain";
    case "watcher": return "Watcher";
    case "capture": return "Capture";
    case "research": return "Research";
    case "digest": return "Wiki digest";
    case "scheduled_task": return "Task";
    case "extractor": return "Extractor";
    case "profile": return "Profile";
    default: return "Chat";
  }
}

/** Phases worth surfacing in a chip label (the gardener-drain stages + research
 *  phases). Ugly internal phases (`running_watcher`, …) are dropped. */
const NICE_PHASES: Record<string, string> = {
  searching: "searching",
  synthesizing: "synthesizing",
  assembling: "assembling",
  harvesting: "harvesting",
  clustering: "clustering",
  resolving: "resolving",
  drafting: "drafting",
};

/** "<Kind>: <detail> <done>/<total>" — a watcher shows its name as the detail,
 *  everything else shows a nice phase; discrete progress is appended. */
function runningLabel(run: PresenceRunLike): string {
  const base = kindShort(run.kind);
  let detail = "";
  const nicePhase = run.phase ? NICE_PHASES[run.phase] : undefined;
  if (run.kind === "watcher" && run.name) detail = run.name;
  else if (nicePhase) detail = nicePhase;
  const progress = run.progress && run.progress.total > 0 ? `${run.progress.done}/${run.progress.total}` : "";
  let label = base;
  if (detail) label += `: ${detail}`;
  if (progress) label += ` ${progress}`;
  return label;
}

/** "in Nm" / "due now" for a future up-next slot. */
function untilLabel(nextRunAt: number, now: number, entryLabel?: string): string {
  const diff = nextRunAt - now;
  if (diff <= 0) return entryLabel && entryLabel.length > 0 ? entryLabel : "due now";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `in ${hrs}h ${mins % 60}m`;
}

function matchesFilter(filter: PresenceFilter, kind: string | undefined, bot: string | undefined): boolean {
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(kind ?? "chat")) return false;
  if (filter.bot && (bot ?? "") !== filter.bot) return false;
  return true;
}

/**
 * The pure presence model for one chip. `running` wins over `preflight`; a
 * running match takes the first matching non-completed run, a preflight takes
 * the earliest matching up-next entry within {@link PRESENCE_HORIZON_MS}
 * (up-next is already ascending by `nextRunAt`). An ETA is attached only when
 * the `estimates` map has a positive expected duration for the run's identity
 * (never fabricated).
 */
export function computePresence(
  filter: PresenceFilter,
  running: PresenceRunLike[],
  upNext: PresenceUpNextLike[],
  estimates: Record<string, number>,
  now: number,
): PresenceModel {
  const liveMatch = running.find(
    (r) => !r.completed && matchesFilter(filter, r.kind, r.botName),
  );
  if (liveMatch) {
    const kind = liveMatch.kind ?? "chat";
    const model: PresenceModel = { state: "running", kind, label: runningLabel(liveMatch) };
    const expected = estimates[estimateIdentity(liveMatch.kind, liveMatch.name)];
    if (expected != null && expected > 0) {
      const remaining = expected - Math.max(0, now - liveMatch.startedAt);
      model.etaLabel = remaining > 0 ? `~${fmtDurationShort(remaining)} left` : "over est.";
    }
    return model;
  }

  let soon: PresenceUpNextLike | undefined;
  for (const u of upNext) {
    if (!matchesFilter(filter, u.kind, u.bot) || u.nextRunAt > now + PRESENCE_HORIZON_MS) continue;
    if (!soon || u.nextRunAt < soon.nextRunAt) soon = u;
  }
  if (soon) {
    return {
      state: "preflight",
      kind: soon.kind,
      nextRunAt: soon.nextRunAt,
      label: `${kindShort(soon.kind)} starts ${untilLabel(soon.nextRunAt, now, soon.label)}`,
    };
  }

  return { state: "none" };
}

// ── Component (styles + html + script) ────────────────────────────────────────

export function agentPresenceStyles(): string {
  return `
    .agent-presence {
      display: none; align-items: center; gap: 7px;
      padding: 3px 10px; border-radius: 13px; text-decoration: none;
      font-size: 12px; line-height: 1.4;
      background: color-mix(in srgb, var(--status-success) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-success) 30%, transparent);
      color: var(--text-secondary); white-space: nowrap; max-width: 100%;
    }
    .agent-presence:hover { border-color: var(--status-success); }
    .agent-presence.preflight {
      background: color-mix(in srgb, var(--status-warning) 12%, transparent);
      border-color: color-mix(in srgb, var(--status-warning) 32%, transparent);
    }
    .agent-presence .ap-label { overflow: hidden; text-overflow: ellipsis; }
    .agent-presence .ap-eta { color: var(--text-dim); font-variant-numeric: tabular-nums; }
    /* Static amber dot for the preflight state (running reuses the shared
       animated .pulse-dot from shared-styles). */
    .agent-presence .ap-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--status-warning);
    }
    .agent-presence .pulse-dot { background: var(--status-success); }
  `;
}

/** Empty, hidden container. `mountId` must be unique on the page. */
export function agentPresenceHtml(mountId: string): string {
  return `<a class="agent-presence" id="${mountId}" href="/agents" title="Open the live agents dashboard"></a>`;
}

/**
 * Standalone poll-and-render script for one chip. Injects `mountId` + `filter`
 * as server-side literals; the JS body is a hand-mirror of {@link
 * computePresence} (no backticks / `${}` in the client JS). Cheap: one 15s poll
 * of `/api/agents/overview`, no SSE.
 */
export function agentPresenceScript(mountId: string, filter: PresenceFilter): string {
  return `
    (function () {
      var MOUNT = ${JSON.stringify(mountId)};
      var FILTER = ${JSON.stringify(filter)};
      var HORIZON = ${PRESENCE_HORIZON_MS};
      var NICE_PHASES = {
        searching: 'searching', synthesizing: 'synthesizing', assembling: 'assembling',
        harvesting: 'harvesting', clustering: 'clustering', resolving: 'resolving', drafting: 'drafting'
      };
      function kindShort(kind) {
        switch (kind) {
          case 'gardener_drain': return 'Drain';
          case 'watcher': return 'Watcher';
          case 'capture': return 'Capture';
          case 'research': return 'Research';
          case 'digest': return 'Wiki digest';
          case 'scheduled_task': return 'Task';
          case 'extractor': return 'Extractor';
          case 'profile': return 'Profile';
          default: return 'Chat';
        }
      }
      function fmtDurationShort(ms) {
        var clamped = ms < 0 ? 0 : ms;
        var s = Math.round(clamped / 1000);
        if (s < 60) return s + 's';
        var m = Math.round(s / 60);
        if (m < 60) return m + 'm';
        var h = Math.floor(m / 60), rm = m % 60;
        return rm ? h + 'h ' + rm + 'm' : h + 'h';
      }
      function estimateIdentity(kind, name) { return (kind || 'chat') + '\\u0000' + (name || ''); }
      function matchesFilter(kind, bot) {
        if (FILTER.kinds && FILTER.kinds.length > 0 && FILTER.kinds.indexOf(kind || 'chat') === -1) return false;
        if (FILTER.bot && (bot || '') !== FILTER.bot) return false;
        return true;
      }
      function runningLabel(run) {
        var base = kindShort(run.kind);
        var detail = '';
        if (run.kind === 'watcher' && run.name) detail = run.name;
        else if (run.phase && NICE_PHASES[run.phase]) detail = NICE_PHASES[run.phase];
        var progress = (run.progress && run.progress.total > 0) ? (run.progress.done + '/' + run.progress.total) : '';
        var label = base;
        if (detail) label += ': ' + detail;
        if (progress) label += ' ' + progress;
        return label;
      }
      function untilLabel(nextRunAt, now, entryLabel) {
        var diff = nextRunAt - now;
        if (diff <= 0) return (entryLabel && entryLabel.length > 0) ? entryLabel : 'due now';
        var mins = Math.round(diff / 60000);
        if (mins < 1) return 'in <1m';
        if (mins < 60) return 'in ' + mins + 'm';
        var hrs = Math.floor(mins / 60);
        return 'in ' + hrs + 'h ' + (mins % 60) + 'm';
      }
      function computePresence(running, upNext, estimates, now) {
        var live = null;
        for (var i = 0; i < running.length; i++) {
          var r = running[i];
          if (!r.completed && matchesFilter(r.kind, r.botName)) { live = r; break; }
        }
        if (live) {
          var m = { state: 'running', kind: live.kind || 'chat', label: runningLabel(live) };
          var expected = estimates[estimateIdentity(live.kind, live.name)];
          if (expected != null && expected > 0) {
            var remaining = expected - Math.max(0, now - live.startedAt);
            m.etaLabel = remaining > 0 ? '~' + fmtDurationShort(remaining) + ' left' : 'over est.';
          }
          return m;
        }
        var soon = null;
        for (var j = 0; j < upNext.length; j++) {
          var u = upNext[j];
          if (!matchesFilter(u.kind, u.bot) || u.nextRunAt > now + HORIZON) continue;
          if (!soon || u.nextRunAt < soon.nextRunAt) soon = u;
        }
        if (soon) {
          return { state: 'preflight', kind: soon.kind, nextRunAt: soon.nextRunAt,
            label: kindShort(soon.kind) + ' starts ' + untilLabel(soon.nextRunAt, now, soon.label) };
        }
        return { state: 'none' };
      }
      function render(m) {
        var el = document.getElementById(MOUNT);
        if (!el) return;
        if (m.state === 'none') { el.style.display = 'none'; el.innerHTML = ''; return; }
        el.className = 'agent-presence' + (m.state === 'preflight' ? ' preflight' : '');
        el.style.display = 'inline-flex';
        el.innerHTML = '';
        var dot = document.createElement('span');
        dot.className = m.state === 'running' ? 'pulse-dot' : 'ap-dot';
        el.appendChild(dot);
        var lab = document.createElement('span');
        lab.className = 'ap-label';
        lab.textContent = m.label;
        el.appendChild(lab);
        if (m.state === 'running' && m.etaLabel) {
          var e = document.createElement('span');
          e.className = 'ap-eta';
          e.textContent = m.etaLabel;
          el.appendChild(e);
        }
      }
      function poll() {
        fetch('/api/agents/overview').then(function (r) { return r.json(); }).then(function (d) {
          render(computePresence(d.running || [], d.upNext || [], d.estimates || {}, Date.now()));
        }).catch(function () {});
      }
      poll();
      setInterval(poll, 15000);
    })();
  `;
}
