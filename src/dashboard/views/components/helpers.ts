/** Inline JS: HTML-escape a string (null-safe, handles &<>"') */
export function escScript(): string {
  return `
    function esc(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
  `;
}

const TOOL_INPUT_PRIORITY_KEYS = ['query', 'pattern', 'prompt', 'text', 'command', 'url', 'file_path', 'path', 'subject', 'q', 'search', 'message', 'name', 'skill'];
const TOOL_INPUT_MAX_LENGTH = 60;

/** Extract a short readable summary from tool input (JSON string or object). Exported for testing. */
export function extractToolInputLabel(input: unknown): string {
  if (!input) return '';
  try {
    const obj = typeof input === 'object' ? input as Record<string, unknown> : JSON.parse(input as string);
    for (const key of TOOL_INPUT_PRIORITY_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) {
        return v.length > TOOL_INPUT_MAX_LENGTH ? v.slice(0, TOOL_INPUT_MAX_LENGTH - 3) + '...' : v;
      }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.length > TOOL_INPUT_MAX_LENGTH ? val.slice(0, TOOL_INPUT_MAX_LENGTH - 3) + '...' : val;
      }
    }
  } catch { /* invalid JSON — return empty */ }
  return '';
}

/** Inline JS: extract a short readable summary from tool input JSON */
export function toolInputLabelScript(): string {
  return `
    function toolInputLabel(input) {
      if (!input) return '';
      try {
        var obj = typeof input === 'object' ? input : JSON.parse(input);
        var keys = ${JSON.stringify(TOOL_INPUT_PRIORITY_KEYS)};
        for (var i = 0; i < keys.length; i++) {
          var v = obj[keys[i]];
          if (typeof v === 'string' && v.length > 0) return v.length > ${TOOL_INPUT_MAX_LENGTH} ? v.slice(0, ${TOOL_INPUT_MAX_LENGTH - 3}) + '...' : v;
        }
        var allKeys = Object.keys(obj);
        for (var j = 0; j < allKeys.length; j++) {
          var val = obj[allKeys[j]];
          if (typeof val === 'string' && val.length > 0) return val.length > ${TOOL_INPUT_MAX_LENGTH} ? val.slice(0, ${TOOL_INPUT_MAX_LENGTH - 3}) + '...' : val;
        }
      } catch (e) {}
      return '';
    }
  `;
}

/** Shared JS helper functions used by multiple dashboard components */
export function helpersScript(): string {
  return `
    ${escScript()}

    function escapeHtml(text) {
      return esc(text);
    }

    function escapeAttr(text) {
      return esc(text);
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return new Date(ts).toLocaleDateString();
    }

    function deadlineText(ts) {
      if (!ts) return '';
      const diff = ts - Date.now();
      const days = Math.floor(diff / 86400000);
      if (days < 0) return Math.abs(days) + 'd overdue';
      if (days === 0) return 'due today';
      if (days === 1) return 'due tomorrow';
      return 'in ' + days + 'd';
    }

    function fmtMs(ms) {
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
    }

    function fmtTokens(n) {
      return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : '' + n;
    }

    ${toolInputLabelScript()}

    function formatSchedule(task) {
      if (task.scheduleIntervalMs) {
        const mins = Math.round(task.scheduleIntervalMs / 60000);
        if (mins < 60) return 'Every ' + mins + 'min';
        return 'Every ' + (mins / 60).toFixed(1) + 'h';
      }
      const h = String(task.scheduleHour).padStart(2, '0');
      const m = String(task.scheduleMinute).padStart(2, '0');
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      let days = '';
      if (task.scheduleDays && task.scheduleDays.length < 7) {
        days = ' on ' + task.scheduleDays.map(d => dayNames[d]).join(', ');
      }
      return h + ':' + m + days;
    }
  `;
}
