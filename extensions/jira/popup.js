const $ = (sel) => document.querySelector(sel);

let issueData = null;

document.addEventListener('DOMContentLoaded', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.url?.match(/jira.*\/browse\/[A-Z]/)) {
    $('#not-jira').classList.remove('hidden');
    return;
  }

  // Ask content script for issue info
  try {
    const info = await sendToTab(tab.id, { type: 'GET_JIRA_INFO' });
    if (info && info.issueKey) {
      issueData = info;
      showIssue(info);
    } else {
      showReloadMessage();
    }
  } catch (e) {
    showReloadMessage();
  }

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

// Show a user picker when the server reports multiple users
function showUserPicker(users, onSelect) {
  // Remove any existing picker
  const existing = $('#user-picker');
  if (existing) existing.remove();

  const picker = document.createElement('div');
  picker.id = 'user-picker';
  picker.style.cssText = 'margin-top:8px;';
  picker.innerHTML = '<div style="font-size:12px;font-weight:500;margin-bottom:6px;">Velg bruker:</div>';

  for (const user of users) {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.style.cssText = 'display:block;width:100%;margin-bottom:4px;text-align:left;font-size:12px;padding:6px 10px;';
    btn.textContent = `${user.name} (${user.id})`;
    btn.addEventListener('click', () => {
      picker.remove();
      onSelect(user.id);
    });
    picker.appendChild(btn);
  }

  $('#issue-info').appendChild(picker);
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

async function handleAnalyze(overrideUserId, forceNew) {
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

    const settings = await chrome.storage.sync.get({ muninnUrl: 'http://localhost:3010', userId: '' });
    const title = issueData.issueKey;
    const text = formatIssueAsText(issueData);

    const payload = { bot: 'melosys', title, text };
    // userId priority: override (from picker) > settings > omit
    const userId = overrideUserId || settings.userId;
    if (userId) payload.userId = userId;
    if (forceNew) payload.forceNew = true;

    const response = await fetch(`${settings.muninnUrl}/api/research/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    // Server asks us to pick a user
    if (result.needsUser && result.users) {
      status.className = 'status-msg hidden';
      btn.disabled = false;
      showUserPicker(result.users, (selectedUserId) => {
        handleAnalyze(selectedUserId, forceNew);
      });
      return;
    }

    // Thread already exists — ask user what to do
    if (result.threadExists) {
      status.className = 'status-msg hidden';
      btn.disabled = false;
      const resolvedUserId = userId || result.userId;
      showThreadExistsDialog(
        result.existingThreadName,
        // Reuse: open the existing thread directly
        () => {
          const chatUrl = `${settings.muninnUrl}/chat?bot=${encodeURIComponent(result.botName)}&thread=${encodeURIComponent(result.existingThreadId)}&user=${encodeURIComponent(resolvedUserId)}`;
          chrome.tabs.create({ url: chatUrl });
          window.close();
        },
        // Create new with timestamp
        () => {
          handleAnalyze(resolvedUserId, true);
        },
      );
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || result.detail || `Error: ${response.status}`);
    }

    // Open chat page
    chrome.tabs.create({ url: `${settings.muninnUrl}${result.chatUrl}` });
    window.close();
  } catch (err) {
    status.className = 'status-msg error';
    status.classList.remove('hidden');
    status.textContent = err.message;
    btn.disabled = false;
  }
}
