const $ = (sel) => document.querySelector(sel);

let issueData = null;
let allUsers = [];
let allConnectors = [];
let muninnUrl = 'http://localhost:3010';
let testMode = false;
const BOT_NAME = 'melosys';

// Default task shown when the popup is opened off a Jira page — an editable
// starting point for a manual end-to-end test of the whole dev loop. Phrased to
// tell the agent up front that this is a test with no backing Jira issue, so it
// builds straight from the description instead of trying to look the issue up.
const DEFAULT_TEST_TASK = `[TEST – ingen Jira-sak]

Lag en enkel backend-tjeneste i melosys-api som returnerer antall fagsaker i systemet, f.eks. GET /api/fagsaker/antall → { "antall": <n> }. Lag deretter en enkel webside i melosys-web som henter og viser dette tallet.

Dette er en testoppgave for å kjøre gjennom hele løkka (analyse → spec → bygg → e2e) manuelt. Det finnes ingen Jira-sak for dette – all kontekst står her.`;

// True when the tab URL points at a Jira Cloud issue. Mirrors content.js
// getIssueKey(): the open issue lives in /browse/<KEY>, ?selectedIssue=<KEY>
// (boards/backlog), or /issues/<KEY> (new issue view).
function isJiraIssueUrl(url) {
  if (!url) return false;
  return /\/browse\/[A-Z][A-Z0-9]+-\d+|[?&]selectedIssue=[A-Z][A-Z0-9]+-\d+|\/issues\/[A-Z][A-Z0-9]+-\d+/.test(url);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Options link works in every mode (Jira issue, reload, and test).
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const settings = await chrome.storage.sync.get({ muninnUrl: 'http://localhost:3010', userId: '', lastUserId: '' });
  muninnUrl = settings.muninnUrl;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  // Off a Jira issue → offer a manual test task instead of a dead end.
  // Cloud (nav.atlassian.net) has no "jira" in the host, so match the issue-key
  // routes directly: /browse/<KEY>, board ?selectedIssue=<KEY>, /issues/<KEY>.
  if (!isJiraIssueUrl(tab?.url)) {
    await setupTestMode(settings);
    return;
  }

  const info = await sendToTab(tab.id, { type: 'GET_JIRA_INFO' }).catch(() => null);
  if (info?.issueKey) {
    issueData = info;
    showIssue(info);
  } else {
    showReloadMessage();
    return;
  }

  // Reveal the button + wire the click handler BEFORE awaiting the loaders so a
  // slow muninn / network blip doesn't leave the popup with an issue title and
  // no Send affordance. The button is disabled while loaders run and re-enabled
  // when the selectors are populated.
  const btn = $('#btn-index');
  btn.disabled = true;
  btn.addEventListener('click', () => handleAnalyze());
  $('#selectors').classList.remove('hidden');

  // Load users first (needed for connector preferences), then connectors and variants
  await loadUsers(settings);
  await Promise.all([loadConnectors(), loadVariants()]);
  btn.disabled = false;
});

// Off-Jira mode: show an editable default task + the same user/variant/model
// selectors, and send it through the normal research pipeline as a test run.
async function setupTestMode(settings) {
  testMode = true;
  // Only show #test-task — its own note already carries the "Ingen Jira-sak åpen"
  // messaging, so unhiding #not-jira too would just duplicate it above the textarea.
  $('#test-task').classList.remove('hidden');
  $('#test-text').value = DEFAULT_TEST_TASK;

  // Same pattern as the Jira path: reveal + wire the button BEFORE loaders so
  // the textarea isn't shown alone for the duration of the user/connector fetches.
  const btn = $('#btn-index');
  btn.textContent = 'Send testanalyse';
  btn.disabled = true;
  btn.addEventListener('click', () => handleAnalyze());
  $('#selectors').classList.remove('hidden');

  await loadUsers(settings);
  await Promise.all([loadConnectors(), loadVariants()]);
  btn.disabled = false;
}

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
  // Target the id directly — querySelector('p') would silently pick the wrong
  // paragraph if a future HTML edit adds a second <p> inside #not-jira.
  $('#not-jira-msg').textContent =
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

  // Fetch users list and DB default in parallel (allSettled so one failure doesn't kill both)
  let dbDefaultUserId = null;
  try {
    const results = await Promise.allSettled([
      fetch(`${muninnUrl}/api/users?bot=${encodeURIComponent(BOT_NAME)}`).then(r => r.ok ? r.json() : null),
      fetch(`${muninnUrl}/chat/bot-preferences/${encodeURIComponent(BOT_NAME)}/default-user`).then(r => r.ok ? r.json() : null),
    ]);
    if (results[0].status === 'fulfilled' && results[0].value) {
      allUsers = (results[0].value.users || []).map(u => ({ id: u.userId || u.id, name: u.username || u.userId || u.id }));
    }
    if (results[1].status === 'fulfilled' && results[1].value) {
      dbDefaultUserId = results[1].value.userId || null;
    }
  } catch {}

  if (allUsers.length === 0) return;

  // Pre-select: DB default (single source of truth) > options page userId > first
  const selectedId = dbDefaultUserId || settings.userId || allUsers[0].id;

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
  const userId = getSelectedUserId();

  // Fetch connectors and user's preferred connector from DB in parallel
  let preferredConnectorId = null;
  try {
    const fetches = [fetch(`${muninnUrl}/api/connectors`).catch(() => null)];
    if (userId) {
      fetches.push(
        fetch(`${muninnUrl}/chat/preferences/${encodeURIComponent(userId)}/${encodeURIComponent(BOT_NAME)}`).catch(() => null)
      );
    }
    const [connRes, prefRes] = await Promise.all(fetches);
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

  // Pre-select: preferred from DB > first in list
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

// Get the currently selected prompt variant id from the dropdown
function getSelectedVariantId() {
  const select = $('#variant-select');
  return select?.value || 'default';
}

// Load Jira-analysis prompt variants from server and populate the dropdown
async function loadVariants() {
  const select = $('#variant-select');
  const row = $('#variant-selector-row');
  const storageKey = `lastVariant.${BOT_NAME}`;

  let variants = [];
  try {
    const res = await fetch(`${muninnUrl}/api/research/variants?bot=${encodeURIComponent(BOT_NAME)}`);
    if (res.ok) {
      const data = await res.json();
      variants = data.variants || [];
    }
  } catch {}

  // Hide row when there are no variants beyond the default
  if (variants.length <= 1) return;

  const stored = await chrome.storage.sync.get({ [storageKey]: 'default' });
  const lastSelected = stored[storageKey];
  const selectedId = variants.find((v) => v.id === lastSelected) ? lastSelected : 'default';

  select.innerHTML = '';
  for (const v of variants) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    if (v.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    chrome.storage.sync.set({ [storageKey]: select.value }).catch(() => {});
  });

  row.style.display = 'flex';
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
  dialog.className = 'status-msg';
  dialog.style.cssText = 'margin-top:8px;';
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
  newBtn.className = 'secondary';
  newBtn.style.cssText = 'font-size:11px;padding:4px 10px;';
  newBtn.textContent = 'Opprett ny';
  newBtn.addEventListener('click', () => { dialog.remove(); onCreateNew(); });

  btnRow.appendChild(reuseBtn);
  btnRow.appendChild(newBtn);
  dialog.appendChild(btnRow);
  // Insert the dialog ABOVE the controls row (not at the end of #selectors) so
  // the Reuse/Create-new choice sits where the user is already looking — putting
  // it after the button + status would push it to the bottom of the popup and
  // make it easy to miss. #selectors is visible in both Jira and test mode.
  const selectors = $('#selectors');
  const controls = selectors.querySelector('.controls');
  selectors.insertBefore(dialog, controls);
}

async function handleAnalyze(forceNew) {
  const btn = $('#btn-index');
  const status = $('#status');

  btn.disabled = true;
  status.className = 'status-msg';
  status.classList.remove('hidden');
  status.innerHTML = '<span class="spinner"></span>Sender til analyse...';

  try {
    let title, text, description;
    if (testMode) {
      // Manual test run — the textarea is the whole task.
      text = $('#test-text').value.trim();
      if (!text) throw new Error('Skriv inn en testoppgave først.');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // Skip ONLY lines that are entirely a bracket-tag (e.g. the leading
      // "[TEST – ingen Jira-sak]" of DEFAULT_TEST_TASK). A line like
      // "[Backend] Verify foo" has content after the closing bracket and is
      // kept as legitimate title material.
      const isPureTag = (l) => /^\[[^\]]*\]\s*$/.test(l);
      const firstContent = lines.find((l) => !isPureTag(l)) || lines[0];
      // Server truncates titles >50 chars (research-routes.ts) — keep the
      // "TEST: " prefix + 44 chars of content within budget so the carefully-
      // chosen slice isn't clipped server-side.
      title = 'TEST: ' + firstContent.slice(0, 44);
      description = firstContent.slice(0, 120);
      // The "TEST: " prefix never matches the server's anchored [A-Z]+-\d+
      // issue-key regex (TEST is followed by a space + colon, not a dash), so
      // the run gets a unique research-<id> key and skips the (would-be fake)
      // Jira knowledge-base ingest. forceNew avoids the threadExists dialog
      // friction on repeat test runs — each Send testanalyse spawns a fresh
      // thread with a timestamp suffix instead of nagging the user to confirm.
      forceNew = true;
    } else {
      // Re-fetch fresh content from DOM
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        try {
          const freshData = await sendToTab(tabs[0].id, { type: 'GET_JIRA_INFO' });
          if (freshData?.issueKey) issueData = freshData;
        } catch (e) { /* use cached */ }
      }
      title = issueData.issueKey;
      text = formatIssueAsText(issueData);
      description = issueData.summary || issueData.title || '';
    }

    const payload = { bot: BOT_NAME, title, text, description };

    // Use the user from the dropdown and sync to DB as the default
    const userId = getSelectedUserId();
    if (userId) {
      payload.userId = userId;
      // Sync to DB (single source of truth — shared with chat page)
      fetch(`${muninnUrl}/chat/bot-preferences/${encodeURIComponent(BOT_NAME)}/default-user`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      }).catch(() => {});
    }

    // Use the connector/model from the dropdown
    const connectorId = getSelectedConnectorId();
    if (connectorId) {
      payload.connectorId = connectorId;
    }
    // Use the prompt variant from the dropdown (omit when default)
    const variantId = getSelectedVariantId();
    if (variantId && variantId !== 'default') {
      payload.promptVariant = variantId;
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
