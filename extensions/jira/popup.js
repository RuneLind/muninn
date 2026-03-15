const $ = (sel) => document.querySelector(sel);

let issueData = null;
let allUsers = [];
let allConnectors = [];
let muninnUrl = 'http://localhost:3010';
const BOT_NAME = 'melosys';

document.addEventListener('DOMContentLoaded', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.url?.match(/jira.*\/browse\/[A-Z]/)) {
    $('#not-jira').classList.remove('hidden');
    return;
  }

  // Load settings and users in parallel with issue info
  const settingsPromise = chrome.storage.sync.get({ muninnUrl: 'http://localhost:3010', userId: '', lastUserId: '' });
  const issuePromise = sendToTab(tab.id, { type: 'GET_JIRA_INFO' }).catch(() => null);

  const [settings, info] = await Promise.all([settingsPromise, issuePromise]);
  muninnUrl = settings.muninnUrl;

  if (info?.issueKey) {
    issueData = info;
    showIssue(info);
  } else {
    showReloadMessage();
    return;
  }

  // Load users and connectors, populate dropdowns
  await Promise.all([loadUsers(settings), loadConnectors()]);

  $('#btn-index').addEventListener('click', () => handleAnalyze());
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function showReloadMessage() {
  $('#not-jira').classList.remove('hidden');
  $('#not-jira').querySelector('p').textContent =
    'Kunne ikke lese Jira-saken. Last siden på nytt (F5) og prøv igjen.';
}

function showIssue(data) {
  $('#issue-key').textContent = data.issueKey;
  $('#issue-title').textContent = data.summary || data.title;
  const meta = [data.status, data.type, data.assignee].filter(Boolean).join(' · ');
  $('#issue-meta').textContent = meta;
  $('#issue-info').classList.remove('hidden');
}

function formatIssueAsText(data) {
  let text = `# ${data.issueKey}: ${data.summary || data.title}\n\n`;
  const meta = [];
  if (data.status) meta.push(`Status: ${data.status}`);
  if (data.type) meta.push(`Type: ${data.type}`);
  if (data.priority) meta.push(`Priority: ${data.priority}`);
  if (data.assignee) meta.push(`Assignee: ${data.assignee}`);
  if (data.reporter) meta.push(`Reporter: ${data.reporter}`);
  if (data.epicLink) meta.push(`Epic: ${data.epicLink}`);
  if (meta.length) text += meta.join(' | ') + '\n\n';
  if (data.description) text += `## Description\n\n${data.description}\n\n`;
  if (data.comments && data.comments.length > 0) {
    text += '## Comments\n\n';
    for (const c of data.comments) {
      text += `### ${c.author} (${c.date})\n${c.body}\n\n`;
    }
  }
  return text;
}

// Load users from server and populate the dropdown
async function loadUsers(settings) {
  const select = $('#user-select');
  const row = $('#user-selector-row');

  // Fetch users list
  try {
    const res = await fetch(`${muninnUrl}/api/users?bot=${encodeURIComponent(BOT_NAME)}`);
    if (res.ok) {
      const data = await res.json();
      allUsers = (data.users || []).map(u => ({ id: u.userId || u.id, name: u.username || u.userId || u.id }));
    }
  } catch {}

  if (allUsers.length === 0) return;

  // Determine which user to pre-select:
  // 1. Preferred user from chat page (server-side)
  // 2. Last used in extension
  // 3. Settings userId
  // 4. First user in list
  let preferredId = null;
  try {
    const prefRes = await fetch(`${muninnUrl}/chat/preferred-user/${encodeURIComponent(BOT_NAME)}`);
    if (prefRes.ok) {
      const prefData = await prefRes.json();
      if (prefData.userId) preferredId = prefData.userId;
    }
  } catch {}

  const selectedId = preferredId || settings.lastUserId || settings.userId || allUsers[0].id;

  // Populate dropdown (use DOM API to avoid XSS from user names)
  select.innerHTML = '';
  for (const u of allUsers) {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = `${u.name} (${u.id})`;
    if (u.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }

  // If stored ID doesn't match any user, select first
  if (!select.value) select.selectedIndex = 0;

  row.style.display = 'flex';
}

// Load connectors (models) from server and populate the dropdown
async function loadConnectors() {
  const select = $('#model-select');
  const row = $('#model-selector-row');

  // Fetch connectors and preferred connector from chat page in parallel
  let preferredConnectorId = null;
  try {
    const [connRes, prefRes] = await Promise.all([
      fetch(`${muninnUrl}/api/connectors`).catch(() => null),
      fetch(`${muninnUrl}/chat/preferred-connector/${encodeURIComponent(BOT_NAME)}`).catch(() => null),
    ]);
    if (connRes?.ok) {
      const data = await connRes.json();
      allConnectors = data.connectors || [];
    }
    if (prefRes?.ok) {
      const prefData = await prefRes.json();
      if (prefData.connectorId) preferredConnectorId = prefData.connectorId;
    }
  } catch {}

  if (allConnectors.length === 0) return;

  // Pre-select: preferred from chat page > first in list
  const selectedId = preferredConnectorId || allConnectors[0].id;

  for (const c of allConnectors) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }

  row.style.display = 'flex';
}

// Get the currently selected connector from the dropdown
function getSelectedConnectorId() {
  const select = $('#model-select');
  return select?.value || null;
}

// Get the currently selected user from the dropdown
function getSelectedUserId() {
  const select = $('#user-select');
  return select?.value || null;
}

// Show a dialog when a thread with the same name already exists
function showThreadExistsDialog(threadName, onReuse, onCreateNew) {
  const existing = $('#thread-exists');
  if (existing) existing.remove();

  const dialog = document.createElement('div');
  dialog.id = 'thread-exists';
  dialog.style.cssText = 'margin-top:8px;padding:8px 12px;background:#fef3c7;border-radius:6px;';
  const label = document.createElement('div');
  label.style.cssText = 'font-size:12px;margin-bottom:6px;';
  label.textContent = 'Tråd ';
  const bold = document.createElement('b');
  bold.textContent = threadName;
  label.appendChild(bold);
  label.appendChild(document.createTextNode(' finnes allerede.'));
  dialog.appendChild(label);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;';

  const reuseBtn = document.createElement('button');
  reuseBtn.className = 'primary';
  reuseBtn.style.cssText = 'font-size:11px;padding:4px 10px;';
  reuseBtn.textContent = 'Bruk eksisterende';
  reuseBtn.addEventListener('click', () => { dialog.remove(); onReuse(); });

  const newBtn = document.createElement('button');
  newBtn.className = 'primary';
  newBtn.style.cssText = 'font-size:11px;padding:4px 10px;background:#059669;';
  newBtn.textContent = 'Opprett ny';
  newBtn.addEventListener('click', () => { dialog.remove(); onCreateNew(); });

  btnRow.appendChild(reuseBtn);
  btnRow.appendChild(newBtn);
  dialog.appendChild(btnRow);
  $('#issue-info').appendChild(dialog);
}

async function handleAnalyze(forceNew) {
  const btn = $('#btn-index');
  const status = $('#status');

  btn.disabled = true;
  status.className = 'status-msg';
  status.classList.remove('hidden');
  status.innerHTML = '<span class="spinner"></span>Sender til analyse...';

  try {
    // Re-fetch fresh content from DOM
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      try {
        const freshData = await sendToTab(tabs[0].id, { type: 'GET_JIRA_INFO' });
        if (freshData?.issueKey) issueData = freshData;
      } catch (e) { /* use cached */ }
    }

    const title = issueData.issueKey;
    const text = formatIssueAsText(issueData);
    const description = issueData.summary || issueData.title || '';
    const payload = { bot: BOT_NAME, title, text, description };

    // Use the user from the dropdown
    const userId = getSelectedUserId();
    if (userId) {
      payload.userId = userId;
      chrome.storage.sync.set({ lastUserId: userId });
    }

    // Use the connector/model from the dropdown
    const connectorId = getSelectedConnectorId();
    if (connectorId) {
      payload.connectorId = connectorId;
    }
    if (forceNew) payload.forceNew = true;

    const response = await fetch(`${muninnUrl}/api/research/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    // Thread already exists — ask user what to do
    if (result.threadExists) {
      status.className = 'status-msg hidden';
      btn.disabled = false;
      showThreadExistsDialog(
        result.existingThreadName,
        // Reuse: open the existing thread directly
        () => {
          const chatUrl = `${muninnUrl}/chat?bot=${encodeURIComponent(result.botName)}&thread=${encodeURIComponent(result.existingThreadId)}&user=${encodeURIComponent(userId || result.userId)}`;
          chrome.tabs.create({ url: chatUrl });
          window.close();
        },
        // Create new with timestamp
        () => {
          handleAnalyze(true);
        },
      );
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || result.detail || `Error: ${response.status}`);
    }

    // Open chat page
    chrome.tabs.create({ url: `${muninnUrl}${result.chatUrl}` });
    window.close();
  } catch (err) {
    status.className = 'status-msg error';
    status.classList.remove('hidden');
    status.textContent = err.message;
    btn.disabled = false;
  }
}
