/**
 * Content script for Jira Cloud issue pages (nav.atlassian.net).
 *
 * Pulls full issue content from the Jira Cloud REST API v3 using the user's
 * authenticated browser session (credentials: 'include') — no API token needed.
 * This mirrors huginn's Playwright fetcher, which obtains a logged-in browser
 * context purely to call the same /rest/api/3 endpoints; here the content script
 * already runs inside that authenticated session, so it calls REST directly.
 *
 * We ask for expand=renderedFields so the API returns description/comment bodies
 * as HTML, which the existing htmlToMarkdown() walker converts — richer than
 * flattening ADF to plain text. The Epic comes from the issue's `parent` (Cloud),
 * not the Server-only customfield_13510 Epic Link.
 */

const FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter',
  'labels', 'created', 'updated', 'parent', 'description', 'comment',
].join(',');

notifyIssuePage();

function getIssueKey() {
  const KEY = /[A-Z][A-Z0-9]+-\d+/;
  // Classic deep link — Cloud still supports /browse/<KEY>.
  let m = window.location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
  if (m) return m[1];
  // Board / backlog views carry the open issue in ?selectedIssue=<KEY>.
  const sel = new URLSearchParams(window.location.search).get('selectedIssue');
  if (sel && KEY.test(sel)) return sel.match(KEY)[0];
  // New issue-view route: /jira/.../issues/<KEY>.
  m = window.location.pathname.match(/\/issues\/([A-Z][A-Z0-9]+-\d+)/);
  if (m) return m[1];
  return null;
}

/**
 * Convert a Jira HTML element to markdown text.
 * Handles headings, lists, bold, italic, links, paragraphs, and line breaks.
 */
function htmlToMarkdown(el) {
  if (!el) return '';

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const childText = () => Array.from(node.childNodes).map(walk).join('');

    switch (tag) {
      case 'h1': return `\n# ${childText().trim()}\n\n`;
      case 'h2': return `\n## ${childText().trim()}\n\n`;
      case 'h3': return `\n### ${childText().trim()}\n\n`;
      case 'h4': return `\n#### ${childText().trim()}\n\n`;
      case 'h5': return `\n##### ${childText().trim()}\n\n`;
      case 'h6': return `\n###### ${childText().trim()}\n\n`;
      case 'p': return `${childText().trim()}\n\n`;
      case 'br': return '\n';
      case 'strong':
      case 'b': return `**${childText().trim()}**`;
      case 'em':
      case 'i': return `*${childText().trim()}*`;
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = childText().trim();
        return href ? `[${text}](${href})` : text;
      }
      case 'ul': {
        const items = Array.from(node.querySelectorAll(':scope > li'));
        return '\n' + items.map(li => `- ${walk(li).trim()}`).join('\n') + '\n\n';
      }
      case 'ol': {
        const items = Array.from(node.querySelectorAll(':scope > li'));
        return '\n' + items.map((li, i) => `${i + 1}. ${walk(li).trim()}`).join('\n') + '\n\n';
      }
      case 'li': return childText();
      case 'code': return `\`${childText()}\``;
      case 'pre': return `\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
      case 'blockquote': {
        const lines = childText().trim().split('\n');
        return '\n' + lines.map(l => `> ${l}`).join('\n') + '\n\n';
      }
      case 'hr': return '\n---\n\n';
      case 'table': return convertTable(node);
      case 'div':
      case 'span':
      case 'section':
      default: return childText();
    }
  }

  function convertTable(tableEl) {
    const rows = Array.from(tableEl.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const result = [];
    rows.forEach((row, idx) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const line = '| ' + cells.map(c => c.textContent.trim()).join(' | ') + ' |';
      result.push(line);
      if (idx === 0) {
        result.push('| ' + cells.map(() => '---').join(' | ') + ' |');
      }
    });
    return '\n' + result.join('\n') + '\n\n';
  }

  let md = walk(el);
  // Clean up excessive blank lines
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

/** Parse an HTML string (from renderedFields) into a detached element to walk. */
function htmlStringToMarkdown(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return htmlToMarkdown(doc.body);
}

/** Build a minimal payload from the page title when the REST call fails. */
function minimalFromTitle(key) {
  const titleFallback = document.title.match(/\[.*?\]\s*(.+?)(?:\s*-\s*(?:JIRA|Jira))?$/);
  const title = titleFallback ? titleFallback[1].trim() : document.title;
  return {
    issueKey: key, url: window.location.href, title, summary: '',
    status: '', type: '', priority: '', assignee: '', reporter: '',
    labels: [], description: '', comments: [], created: '', updated: '', epicLink: '',
  };
}

async function extractIssueContent() {
  const key = getIssueKey();
  if (!key) return null;

  let data;
  try {
    const url = `${window.location.origin}/rest/api/3/issue/${encodeURIComponent(key)}`
      + `?fields=${FIELDS}&expand=renderedFields`;
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.warn(`[jira-ext] REST ${resp.status} for ${key}; sending minimal payload`);
      return minimalFromTitle(key);
    }
    data = await resp.json();
  } catch (e) {
    console.warn(`[jira-ext] REST fetch failed for ${key}:`, e);
    return minimalFromTitle(key);
  }

  const f = data.fields || {};
  const rf = data.renderedFields || {};

  const summary = f.summary || '';
  const status = f.status?.name || '';
  const type = f.issuetype?.name || '';
  const priority = f.priority?.name || '';
  const assignee = f.assignee?.displayName || '';
  const reporter = f.reporter?.displayName || '';
  const labels = Array.isArray(f.labels) ? f.labels : [];
  const created = f.created || '';
  const updated = f.updated || '';

  // Description — prefer rendered HTML (richer); ADF is not rendered to markdown here.
  const description = htmlStringToMarkdown(rf.description || '');

  // Comments — authors/dates from fields, bodies from renderedFields (parallel arrays).
  const rawComments = f.comment?.comments || [];
  const renderedComments = rf.comment?.comments || [];
  const comments = rawComments.map((c, i) => ({
    author: c.author?.displayName || 'Unknown',
    date: c.created || '',
    body: htmlStringToMarkdown(renderedComments[i]?.body || ''),
  }));

  // Epic = parent, when the parent is itself an Epic (Cloud convention).
  const parent = f.parent || {};
  const parentType = parent.fields?.issuetype?.name || '';
  const epicLink = (parent.key && parentType.toLowerCase() === 'epic')
    ? `${parent.key} - ${parent.fields?.summary || ''}`.trim().replace(/ -\s*$/, '')
    : '';

  const title = summary || minimalFromTitle(key).title;

  return {
    issueKey: key,
    url: window.location.href,
    title,
    summary,
    status,
    type,
    priority,
    assignee,
    reporter,
    labels,
    description,
    comments,
    created,
    updated,
    epicLink,
  };
}

async function notifyIssuePage() {
  const key = getIssueKey();
  if (!key) return;
  const data = await extractIssueContent();
  if (data) {
    chrome.runtime.sendMessage({ type: 'JIRA_ISSUE_PAGE', ...data }, () => {
      // Suppress "message port closed" warning
      void chrome.runtime.lastError;
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_JIRA_INFO') {
    // extractIssueContent is async (REST call) — return true to keep the port
    // open and respond once the fetch resolves.
    extractIssueContent().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
});
