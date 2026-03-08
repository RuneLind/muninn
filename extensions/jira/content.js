/**
 * Content script for Jira issue pages.
 * Extracts full issue content from DOM — no Jira API needed since user is already authenticated.
 */

const issueKey = getIssueKey();
if (issueKey) {
  notifyIssuePage(issueKey);
}

function getIssueKey() {
  const match = window.location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
  return match ? match[1] : null;
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

function extractIssueContent() {
  const key = getIssueKey();
  if (!key) return null;

  // Summary/title
  const summary = document.querySelector('#summary-val')?.textContent?.trim() || '';

  // Status
  const status = document.querySelector('.jira-issue-status-lozenge')?.textContent?.trim()
    || document.querySelector('#opsbar-transitions_more')?.textContent?.trim() || '';

  // Metadata fields
  const type = document.querySelector('#type-val')?.textContent?.trim() || '';
  const priority = document.querySelector('#priority-val')?.textContent?.trim() || '';
  const assignee = document.querySelector('#assignee-val')?.textContent?.trim() || '';
  const reporter = document.querySelector('#reporter-val')?.textContent?.trim() || '';

  // Labels
  const labelEls = document.querySelectorAll('.labels-wrap .lozenge');
  const labels = Array.from(labelEls).map(el => el.textContent.trim()).filter(Boolean);

  // Description — convert HTML to markdown to preserve structure
  const descEl = document.querySelector('#description-val .user-content-block')
    || document.querySelector('#description-val');
  const description = htmlToMarkdown(descEl);

  // Comments — also convert HTML to markdown
  const commentEls = document.querySelectorAll('.activity-comment');
  const comments = Array.from(commentEls).map(el => {
    const author = el.querySelector('.action-head .user-hover')?.textContent?.trim() || 'Unknown';
    const date = el.querySelector('.action-head .date')?.textContent?.trim()
      || el.querySelector('.action-head time')?.getAttribute('datetime') || '';
    const bodyEl = el.querySelector('.action-body');
    const body = htmlToMarkdown(bodyEl);
    return { author, date, body };
  });

  // Dates
  const created = document.querySelector('#created-val time')?.getAttribute('datetime') || '';
  const updated = document.querySelector('#updated-val time')?.getAttribute('datetime') || '';

  // Epic link
  const epicLink = document.querySelector('#customfield_13510-val')?.textContent?.trim() || '';

  // Title fallback from document.title
  const titleFallback = document.title.match(/\[.*?\]\s*(.+?)(?:\s*-\s*(?:JIRA|Jira))?$/);
  const title = summary || (titleFallback ? titleFallback[1].trim() : document.title);

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

function notifyIssuePage(issueKey) {
  const data = extractIssueContent();
  if (data) {
    chrome.runtime.sendMessage({ type: 'JIRA_ISSUE_PAGE', ...data }, () => {
      // Suppress "message port closed" warning
      void chrome.runtime.lastError;
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_JIRA_INFO') {
    sendResponse(extractIssueContent());
  }
});
