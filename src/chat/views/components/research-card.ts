// Research card functions — exported as a browser-compatible JS string
// for injection inside the CHAT_SCRIPT IIFE via ${researchCardScript()}.
//
// Has access to IIFE-scoped variables: selectedBot, selectedUserId, activeConvId,
// activeThreadId, chatMessages, chatInput, bots, threads, connectors,
// escapeHtml, sanitizeHtml, formatWebHtml, scrollToBottom, sendMessage,
// pendingConnector, getBotInfo, isResearchThread, researchBotReplies,
// researchIssueKey, reportExists.
// Defines: RESEARCH_MARKER (used by appendMessage in page.ts).

/** Returns all research card functions as a browser-compatible JS string. */
export function researchCardScript(): string {
  return `
  // ── Research card helpers ───────────────────────────────────────────────

  var RESEARCH_MARKER = '<!-- research:jira -->';

  function parseResearchContent(text) {
    // Extract prompt instruction and Jira content, split by --- separator
    var parts = text.split('\\n---\\n');
    var promptInstruction = '';
    var jiraContent;
    if (parts.length > 1) {
      promptInstruction = parts[0].replace(RESEARCH_MARKER, '').trim();
      jiraContent = parts.slice(1).join('\\n---\\n').trim();
    } else {
      jiraContent = text.replace(RESEARCH_MARKER, '').trim();
    }
    // Extract issue key (e.g. "MELOSYS-7546") from content — may appear after # heading prefix
    var issueKey = null;
    var keyMatch = jiraContent.match(/^(?:#+ *)?([A-Z]+-\\d+)/);
    if (keyMatch) issueKey = keyMatch[1];
    // Extract title from first heading or line
    var lines = jiraContent.split('\\n');
    var title = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.startsWith('#')) { title = line.replace(/^#+\\s*/, ''); break; }
      if (line) { title = line.length > 80 ? line.slice(0, 77) + '...' : line; break; }
    }
    return { title: title || 'Jira Task', content: jiraContent, issueKey: issueKey, prompt: promptInstruction };
  }

  function renderResearchCard(parsed) {
    var renderedBody = sanitizeHtml(formatWebHtml(parsed.content), true);
    var titleHtml = parsed.title ? '<span class="research-card-title">' + escapeHtml(parsed.title) + '</span>' : '';
    var promptHtml = parsed.prompt ? '<div class="research-card-prompt">' + escapeHtml(parsed.prompt) + '</div>' : '';
    return '<div class="research-card-header">' +
      '<span class="research-card-label">Jira Research</span>' +
      titleHtml +
      '</div>' +
      promptHtml +
      '<div class="research-card-body web-content">' + renderedBody + '</div>';
  }

  function checkReportExists(botName, issueKey) {
    if (!botName || !issueKey || !selectedUserId) return;
    fetch('/chat/reports/' + encodeURIComponent(botName) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(issueKey), { method: 'HEAD' })
      .then(function(res) {
        reportExists = res.ok;
        // Refresh action buttons if they're currently showing
        var existing = chatMessages.querySelector('.research-actions');
        if (existing && reportExists) {
          var phase = researchBotReplies >= 3 ? 'deepAnalysis' : researchBotReplies >= 2 ? 'investigation' : 'analysis';
          showResearchActions(phase);
        }
      })
      .catch(function() { reportExists = false; });
  }

  function showResearchActions(phase) {
    // Remove any existing action buttons
    var existing = chatMessages.querySelector('.research-actions');
    if (existing) existing.remove();

    var actions = document.createElement('div');
    actions.className = 'research-actions';

    // Phase 1 (after analysis): Investigate Code + Start Building + Save Report
    // Phase 2 (after investigation): Deep Analysis + Start Building + Save Report
    // Phase 3 (after deep analysis): Start Building + Save Report
    if (phase === 'analysis') {
      var investigateBtn = document.createElement('button');
      investigateBtn.innerHTML = '<span class="btn-icon">&#x1F50D;</span> Investigate Code';
      investigateBtn.onclick = function() {
        actions.classList.add('used');
        var bot = bots.find(function(b) { return b.name === selectedBot; });
        var defaultPrompt = 'Based on the Jira analysis above, investigate the relevant code in the codebase. Find the files and functions that would need to change, show the current implementation, and identify any potential challenges.';
        chatInput.value = '<!-- prompt:investigate -->' + ((bot && bot.prompts && bot.prompts.investigateCode) || defaultPrompt);
        sendMessage();
      };
      actions.appendChild(investigateBtn);
    }

    if (phase === 'investigation') {
      var deepBtn = document.createElement('button');
      deepBtn.innerHTML = '<span class="btn-icon">&#x1F9EA;</span> Deep Analysis';
      deepBtn.onclick = function() {
        actions.classList.add('used');
        var bot = bots.find(function(b) { return b.name === selectedBot; });
        var defaultPrompt = 'Based on the code investigation above, do a deep verification pass. For each file, function, or code path mentioned — spawn parallel read_agent tasks to verify the claims by reading the actual source code and grepping for real call sites. Specifically:\\n\\n1. For each function identified as needing changes: verify it is actually called from the relevant flow (grep for call sites)\\n2. For similar files in different directories: diff them to confirm whether they are structurally identical or different\\n3. For constants and enum values: verify actual values, not just names\\n4. For claimed dependencies between components: verify the import chain\\n\\nRun these verifications in parallel using multiple task agents. Then synthesize:\\n- Verified complexity assessment (what is confirmed vs. assumed)\\n- What remains unclear or uncertain\\n- Any corrections to the initial investigation findings';
        chatInput.value = '<!-- prompt:deepAnalysis -->' + ((bot && bot.prompts && bot.prompts.deepAnalysis) || defaultPrompt);
        sendMessage();
      };
      actions.appendChild(deepBtn);
    }

    if (phase === 'deepAnalysis') {
      var bot = bots.find(function(b) { return b.name === selectedBot; });
      var specPrompt = bot && bot.prompts && bot.prompts.specGeneration;
      if (specPrompt) {
        var specBtn = document.createElement('button');
        specBtn.innerHTML = '<span class="btn-icon">&#x1F4DD;</span> Generate Test Spec';
        specBtn.onclick = function() {
          actions.classList.add('used');
          chatInput.value = '<!-- prompt:specGeneration -->' + specPrompt;
          sendMessage();
        };
        actions.appendChild(specBtn);
      }
    }

    // Start Building hands the saved work plan to an online coding agent via
    // hivemind. Disabled until a work plan exists (Create Workplan re-renders
    // this row on save, which flips reportExists → button enabled).
    var buildBtn = document.createElement('button');
    buildBtn.innerHTML = '<span class="btn-icon">&#x1F680;</span> Start Building';
    buildBtn.disabled = !reportExists;
    if (!reportExists) buildBtn.title = 'Create a work plan first';
    buildBtn.onclick = function() {
      if (!reportExists || !researchIssueKey) return;
      actions.classList.add('used');
      var bot = bots.find(function(b) { return b.name === selectedBot; });
      var planPath = (bot && bot.dir && selectedUserId)
        ? bot.dir + '/reports/' + selectedUserId + '/' + researchIssueKey + '.md'
        : '';
      awaitingHandoffConfirm = true;
      chatInput.value = '<!-- prompt:startBuilding -->' + buildStartBuildingPrompt(planPath);
      sendMessage();
    };
    actions.appendChild(buildBtn);

    var saveBtn = document.createElement('button');
    saveBtn.innerHTML = '<span class="btn-icon">&#x1F4CB;</span> Create Workplan';
    saveBtn.onclick = function() {
      saveResearchReport();
    };
    actions.appendChild(saveBtn);

    if (reportExists && researchIssueKey) {
      var previewBtn = document.createElement('button');
      previewBtn.innerHTML = '<span class="btn-icon">&#x1F4C4;</span> Preview Workplan';
      previewBtn.onclick = function() {
        previewResearchReport();
      };
      actions.appendChild(previewBtn);
    }

    chatMessages.appendChild(actions);
    scrollToBottom();
  }

  // What the receiving coding agent is told to do with the plan: read it, verify
  // it against the ACTUAL code, and use the knowledge base for domain facts —
  // not just rubber-stamp the plan. Shared by the initial and confirm prompts.
  function handoffReviewInstruction() {
    return 'REVIEW the plan before any implementation: read it in full, verify every claim against the ACTUAL code in the repository (open the referenced files and functions — do not trust the plan\\'s summary), and use the knowledge base (search_knowledge) to verify domain / subject-matter ("faglige") facts. ' +
      'Then write a reviewed plan into /Users/rune/source/nav/melosys-kode-wiki (follow that wiki\\'s CLAUDE.md conventions for placement and naming), noting any corrections, gaps, or risks found.';
  }

  // Instruction sent when Start Building is clicked. Asks the (hivemind-enabled)
  // bot to find online coding agents and RECOMMEND one — but wait for
  // the user to confirm before sending anything. The full handoff intent is
  // stated up front so the bot has it in context when the user confirms.
  function buildStartBuildingPrompt(planPath) {
    var pathLine = planPath
      ? 'The work plan for this task is saved at:\\n' + planPath + '\\n\\n'
      : 'The work plan for this task is saved as the research report for ' + (researchIssueKey || 'this issue') + ' in your reports/ folder.\\n\\n';
    return pathLine +
      'Use the hivemind list_peers tool (scope: "machine") to see which agents are online. ' +
      'Identify the candidate coding agents: peers whose working directory is a code repository (e.g. in the "nav" namespace under /Users/rune/source/nav/ — melosys-api-claude, melosys-web, melosys-trygdeavgift-beregning). ' +
      'Ignore peers that are muninn bots (cwd under .../muninn/bots/) and other non-implementer infra peers.\\n\\n' +
      'Read the work plan to understand which repo/area it touches. Then recommend the SINGLE best agent to implement it, weighing each candidate\\'s repo, current branch, and summary. Present:\\n' +
      '- Your recommended agent (peer id) with its repo + branch and a one-line reason\\n' +
      '- The other online coding-agent candidates as alternatives\\n\\n' +
      'IMPORTANT: Do NOT message any agent yet. Stop after presenting your recommendation and wait — I will confirm or name a different agent. ' +
      'When I confirm, send the chosen agent a hivemind message pointing it at the work plan (absolute path above) and instructing it to ' +
      handoffReviewInstruction() + ' Then have it report back here what it produced.';
  }

  // Confirm row shown after the bot returns its coding-agent recommendation.
  // Clicking sends the go-ahead; the bot then performs the hivemind send_message.
  function showHandoffConfirm() {
    var existing = chatMessages.querySelector('.research-actions');
    if (existing) existing.remove();

    var actions = document.createElement('div');
    actions.className = 'research-actions';

    var confirmBtn = document.createElement('button');
    confirmBtn.innerHTML = '<span class="btn-icon">&#x1F91D;</span> Confirm Handoff';
    confirmBtn.onclick = function() {
      actions.classList.add('used');
      chatInput.value = '<!-- prompt:confirmHandoff -->Confirmed — proceed with the handoff to your recommended coding agent now. ' +
        'Send it the work plan via hivemind and instruct it to ' + handoffReviewInstruction() + ' ' +
        'Then report back here what you sent and to whom.';
      sendMessage();
    };
    actions.appendChild(confirmBtn);

    var hint = document.createElement('span');
    hint.className = 'research-actions-hint';
    hint.textContent = 'or reply with a different agent to hand off to';
    actions.appendChild(hint);

    chatMessages.appendChild(actions);
    scrollToBottom();
  }

  async function saveResearchReport() {
    if (!activeConvId || !activeThreadId || !selectedBot || !selectedUserId) return;
    // Use issue key or fall back to thread-based name
    var issueKey = researchIssueKey || ('research-' + activeThreadId.slice(0, 8));

    // Fetch raw messages from DB (preserves markdown formatting, links, code blocks)
    var url = '/chat/conversations/' + activeConvId + '/messages?raw=true';
    if (activeThreadId) url += '&thread=' + encodeURIComponent(activeThreadId);
    var res = await fetch(url);
    var data = await res.json();
    var msgs = data.messages || [];

    // Separate into jira content, analysis response, investigation response, deep analysis response
    var jiraContent = '';
    var analysisResponse = '';
    var investigationResponse = '';
    var deepAnalysisResponse = '';
    var botReplyCount = 0;
    var foundResearch = false;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.sender === 'user' && m.text.indexOf(RESEARCH_MARKER) === 0) {
        foundResearch = true;
        var parsed = parseResearchContent(m.text);
        jiraContent = parsed.content;
      } else if (foundResearch && m.sender === 'bot') {
        botReplyCount++;
        if (botReplyCount === 1) analysisResponse = m.text;
        else if (botReplyCount === 2) investigationResponse = m.text;
        else if (botReplyCount === 3) deepAnalysisResponse = m.text;
      }
    }

    // Extract title from jira content first line
    var titleLine = issueKey;
    if (jiraContent) {
      var lines = jiraContent.split('\\n');
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j].trim();
        if (ln.startsWith('#')) { titleLine = issueKey + ': ' + ln.replace(/^#+\\s*/, ''); break; }
        if (ln) { titleLine = ln.length > 100 ? ln.slice(0, 97) + '...' : ln; break; }
      }
    }

    // Resolve connector name for the active thread
    var reportConnector = '';
    if (activeThreadId) {
      for (var ci = 0; ci < threads.length; ci++) {
        if (threads[ci].id === activeThreadId && threads[ci].connectorName) {
          reportConnector = threads[ci].connectorName;
          break;
        }
      }
    }
    if (!reportConnector) {
      var bot = getBotInfo();
      if (bot) reportConnector = (bot.connector || 'claude-cli') + (bot.model ? ' ' + bot.model : '');
    }

    var now = new Date().toISOString().split('T')[0];
    var sections = [];
    sections.push('---');
    sections.push('issue: ' + issueKey);
    sections.push('bot: ' + selectedBot);
    sections.push('model: ' + reportConnector);
    sections.push('date: ' + now);
    sections.push('---');
    sections.push('');
    sections.push('# ' + titleLine);
    sections.push('');
    if (jiraContent) {
      sections.push('## Task Description');
      sections.push('');
      sections.push(jiraContent);
      sections.push('');
    }
    if (analysisResponse) {
      sections.push('## Research Findings');
      sections.push('');
      sections.push(analysisResponse);
      sections.push('');
    }
    if (investigationResponse) {
      sections.push('## Code Analysis');
      sections.push('');
      sections.push(investigationResponse);
      sections.push('');
    }
    if (deepAnalysisResponse) {
      sections.push('## Deep Analysis');
      sections.push('');
      sections.push(deepAnalysisResponse);
      sections.push('');
    }
    sections.push('---');
    sections.push('**Issue:** ' + issueKey + ' | **Bot:** ' + selectedBot + ' | **Model:** ' + reportConnector + ' | **Generated:** ' + new Date().toISOString());

    var report = sections.join('\\n');

    // Save to backend
    try {
      var saveRes = await fetch('/chat/reports/' + encodeURIComponent(selectedBot) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(issueKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: report }),
      });
      if (saveRes.ok) {
        reportExists = true;
        // Update researchIssueKey if it was a fallback
        if (!researchIssueKey) researchIssueKey = issueKey;
        // Refresh action buttons to show Preview
        var phase = researchBotReplies >= 3 ? 'deepAnalysis' : researchBotReplies >= 2 ? 'investigation' : 'analysis';
        showResearchActions(phase);
        // Brief visual feedback on the save button — Save/Workplan button position varies by phase
        var saveBtnIdx = phase === 'analysis' ? 3 : phase === 'investigation' ? 3 : 2;
        var btn = chatMessages.querySelector('.research-actions button:nth-child(' + saveBtnIdx + ')');
        if (btn) {
          var orig = btn.innerHTML;
          btn.innerHTML = '<span class="btn-icon">&#x2705;</span> Saved!';
          setTimeout(function() { btn.innerHTML = orig; }, 2000);
        }
      }
    } catch (err) {
      console.error('Failed to save report:', err);
    }
  }

  function previewResearchReport() {
    if (!selectedBot || !selectedUserId || !researchIssueKey) return;
    var overlay = document.getElementById('docOverlay');
    var titleEl = document.getElementById('docPanelTitle');
    var linksEl = document.getElementById('docPanelLinks');
    var bodyEl = document.getElementById('docPanelBody');

    titleEl.textContent = researchIssueKey + ' Workplan';
    linksEl.innerHTML = '';
    bodyEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim)">Loading report...</div>';
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';

    fetch('/chat/reports/' + encodeURIComponent(selectedBot) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(researchIssueKey))
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        bodyEl.innerHTML = renderMarkdown(data.content);
      })
      .catch(function(err) {
        bodyEl.innerHTML = '<div style="color:var(--status-error);padding:40px;text-align:center">Failed to load report: ' + esc(err.message) + '</div>';
      });
  }
  `;
}
