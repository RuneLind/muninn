// Research card functions — exported as a browser-compatible JS string
// for injection inside the CHAT_SCRIPT IIFE via ${researchCardScript()}.
//
// Has access to IIFE-scoped variables: selectedBot, selectedUserId, activeConvId,
// activeThreadId, chatMessages, chatInput, bots, threads, connectors,
// escapeHtml, sanitizeHtml, formatWebHtml, scrollToBottom, sendMessage,
// pendingConnector, getBotInfo, isResearchThread, researchBotReplies,
// researchIssueKey, reportExists, pendingHandoffRoles, awaitingSpecReview,
// specGenerated, specApproved.
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

  // Derive the spec's approval state for the active research thread by reading
  // the saved spec's frontmatter status (approved | draft). Mirrors
  // checkReportExists so a page reload re-establishes whether Start Building's
  // spec gate is satisfied. No-ops for bots without a specDomain prompt (they
  // don't take part in the spec-first loop, so the gate never applies).
  function checkSpecStatus(botName, issueKey) {
    if (!botName || !issueKey || !selectedUserId) return;
    var bot = bots.find(function(b) { return b.name === botName; });
    if (!(bot && bot.prompts && bot.prompts.specDomain)) return;
    fetch('/chat/specs/' + encodeURIComponent(botName) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(issueKey))
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        if (!data || !data.content) { specApproved = false; return; }
        specGenerated = true;
        // Read status only out of the leading YAML frontmatter block so a
        // 'status:' line in the spec body can't be mistaken for it.
        var fm = data.content.match(/^---\\n([\\s\\S]*?)\\n---/);
        var statusMatch = fm ? fm[1].match(/(?:^|\\n)status:\\s*(\\w+)/) : null;
        specApproved = !!(statusMatch && statusMatch[1] === 'approved');
        // Refresh the action row if it's showing, so the Start Building gate
        // reflects the resolved approval state.
        var existing = chatMessages.querySelector('.research-actions');
        if (existing) {
          var phase = researchBotReplies >= 3 ? 'deepAnalysis' : researchBotReplies >= 2 ? 'investigation' : 'analysis';
          showResearchActions(phase);
        }
      })
      .catch(function() { specApproved = false; });
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

      // Generate Spec — drafts the domain layer (Forretningsregel + Gitt/Når/Så +
      // Akseptansekriterier) early, from the issue not the code, so a fagperson can
      // review it before any build/test handoff. Only for bots with a specDomain prompt.
      var domainBot = bots.find(function(b) { return b.name === selectedBot; });
      var domainPrompt = domainBot && domainBot.prompts && domainBot.prompts.specDomain;
      if (domainPrompt) {
        var specDomainBtn = document.createElement('button');
        specDomainBtn.innerHTML = '<span class="btn-icon">&#x1F4DD;</span> Generate Spec';
        specDomainBtn.onclick = function() {
          actions.classList.add('used');
          awaitingSpecReview = true;
          chatInput.value = '<!-- prompt:specDomain -->' + domainPrompt;
          sendMessage();
        };
        actions.appendChild(specDomainBtn);
      }
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

    // Start Building fans the work out to a build agent — and, for bots that take
    // part in the spec-first loop (a specDomain prompt), a test agent in parallel.
    // Disabled until a work plan exists; spec-loop bots additionally require an
    // approved domain spec so the test agent gets a real contract (the Phase 3
    // approval gate). Create Workplan / the approval gate re-render this row,
    // flipping reportExists / specApproved → button enabled.
    var hbot = getBotInfo();
    var hasSpecDomain = !!(hbot && hbot.prompts && hbot.prompts.specDomain);
    var buildBtn = document.createElement('button');
    buildBtn.innerHTML = '<span class="btn-icon">&#x1F680;</span> Start Building';
    buildBtn.disabled = !reportExists || (hasSpecDomain && !specApproved);
    if (!reportExists) buildBtn.title = 'Create a work plan first';
    else if (hasSpecDomain && !specApproved) buildBtn.title = 'Approve the domain spec first';
    buildBtn.onclick = function() {
      if (buildBtn.disabled || !researchIssueKey) return;
      actions.classList.add('used');
      var paths = handoffPaths();
      // Fan out to a test agent only when an approved domain spec exists to bind.
      var roles = specApproved ? ['build', 'test'] : ['build'];
      pendingHandoffRoles = roles;
      chatInput.value = '<!-- prompt:startBuilding -->' + buildStartBuildingPrompt(paths.planPath, paths.specPath, roles);
      sendMessage();
    };
    actions.appendChild(buildBtn);

    var saveBtn = document.createElement('button');
    saveBtn.innerHTML = '<span class="btn-icon">&#x1F4CB;</span> Create Workplan';
    saveBtn.onclick = function() {
      saveResearchReport();
    };
    actions.appendChild(saveBtn);

    // Save Spec — persists the generated domain spec as a draft. Appears once a
    // spec has been generated this thread; the fagperson gate's Approve does the
    // same save with an 'approved' status flip.
    if (specGenerated) {
      var saveSpecBtn = document.createElement('button');
      saveSpecBtn.innerHTML = '<span class="btn-icon">&#x1F4BE;</span> Save Spec';
      saveSpecBtn.onclick = function() {
        saveDomainSpec(false);
      };
      actions.appendChild(saveSpecBtn);
    }

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

  // Absolute paths to the two handoff artifacts for the active research thread.
  // Deterministic from the bot dir + user + issue key, so both Start Building and
  // the confirm step derive them identically without stashing extra state.
  function handoffPaths() {
    var bot = getBotInfo();
    var base = (bot && bot.dir && selectedUserId && researchIssueKey) ? bot.dir : '';
    return {
      planPath: base ? base + '/reports/' + selectedUserId + '/' + researchIssueKey + '.md' : '',
      specPath: base ? base + '/specs/' + selectedUserId + '/' + researchIssueKey + '.md' : '',
    };
  }

  // What the BUILD agent is told to do with the plan: read it, verify it against
  // the ACTUAL code, confirm it satisfies the acceptance criteria, then implement.
  // Reframed in Phase 3 from "review the plan" to "verify the plan satisfies the
  // acceptance criteria against real code." Shared by the initial + confirm prompts.
  function handoffReviewInstruction() {
    return 'REVIEW the plan before any implementation: read it in full, verify every claim against the ACTUAL code in the repository (open the referenced files and functions — do not trust the plan\\'s summary), and use the knowledge base (search_knowledge) to verify domain / subject-matter ("faglige") facts. ' +
      'Verify the plan actually satisfies the acceptance criteria against the real code before you implement. ' +
      'Then write a reviewed plan into /Users/rune/source/nav/melosys-kode-wiki (follow that wiki\\'s CLAUDE.md conventions for placement and naming), noting any corrections, gaps, or risks found, and implement it.';
  }

  // What the TEST agent is told to do with the approved domain spec: bind it to
  // the e2e-tests repo via spec-from-analysis and report back the e2e_spec_path.
  // The binding hints (files/functions/constants surfaced during code
  // investigation) are passed by pointing at the workplan's Code Analysis section
  // rather than copied inline — robust, and keeps the domain spec binding-free.
  function testHandoffInstruction(specPath, planPath) {
    return 'Use the approved domain spec at ' + specPath + ' as the contract. ' +
      'Run the spec-from-analysis skill to bind it to the melosys-e2e-tests repo: produce specs/<flow>.md (the domain section from the spec plus the technical binding) and the matching .spec.ts, then run the round-trip self-check. ' +
      'For technical binding hints (relevant files, functions, constants surfaced during code investigation) consult the Code Analysis section of the workplan at ' + planPath + '. ' +
      'Report back the e2e_spec_path — the path of the spec file you land in the e2e-tests repo.';
  }

  // Instruction sent when Start Building is clicked. Asks the (hivemind-enabled)
  // bot to find online coding agents and RECOMMEND a build agent (and, when a
  // test role is in play, a test agent) — but wait for the user to confirm before
  // sending anything. The full fan-out intent is stated up front so the bot has it
  // in context when the user confirms. roles ∈ subsets of ['build','test'].
  function buildStartBuildingPrompt(planPath, specPath, roles) {
    roles = roles || ['build'];
    var wantTest = roles.indexOf('test') !== -1;
    var pathLines = planPath
      ? 'Work plan (for the build agent) is saved at:\\n' + planPath + '\\n'
      : 'Work plan (for the build agent) is the saved research report for ' + (researchIssueKey || 'this issue') + ' in your reports/ folder.\\n';
    if (wantTest) pathLines += 'Domain spec (for the test agent) is saved at:\\n' + specPath + '\\n';
    pathLines += '\\n';

    var goal = wantTest
      ? 'Hand this off to TWO agents to work in parallel: a BUILD agent that implements the work plan, and a TEST agent that writes the e2e spec + test.\\n\\n'
      : 'Hand this off to ONE BUILD agent that implements the work plan.\\n\\n';

    return pathLines + goal +
      'Use the hivemind list_peers tool (scope: "machine") to see which agents are online. ' +
      'Candidate BUILD agents are peers whose working directory is a code repository under /Users/rune/source/nav/ (e.g. melosys-api-claude, melosys-web, melosys-trygdeavgift-beregning). ' +
      (wantTest ? 'The candidate TEST agent is the peer working in the melosys-e2e-tests repo. ' : '') +
      'Ignore peers that are muninn bots (cwd under .../muninn/bots/) and other non-implementer infra peers.\\n\\n' +
      'Read the work plan to understand which repo/area it touches. Then recommend the SINGLE best BUILD agent' + (wantTest ? ' AND the TEST agent' : '') + ', weighing each candidate\\'s repo, current branch, and summary. Present:\\n' +
      '- Recommended BUILD agent (peer id) with its repo + branch and a one-line reason\\n' +
      (wantTest ? '- Recommended TEST agent (peer id) with its repo + branch\\n' : '') +
      '- The other online coding-agent candidates as alternatives\\n\\n' +
      'AVAILABILITY GUARD: if no online peer qualifies for a required role' + (wantTest ? ' (e.g. no agent in melosys-e2e-tests for the test role)' : '') + ', do NOT proceed — tell me exactly which role has no candidate online so I can start that agent first.\\n\\n' +
      'IMPORTANT: Do NOT message any agent yet. Stop after presenting your recommendation and wait — I will confirm or name different agents. ' +
      'When I confirm, use the delegate_task tool (NOT send_to_peer) once per role so each handoff is tracked under this dev run. Each call takes the params to (the peer id), role, and a message carrying the instructions: ' +
      'delegate_task(to: <build peer>, role: "build", message: <point it at the work plan and instruct it to ' + handoffReviewInstruction() + '>)' +
      (wantTest ? ' Then delegate_task(to: <test peer>, role: "test", message: <point it at the domain spec and instruct it to ' + testHandoffInstruction(specPath, planPath) + '>)' : '') +
      ' Then report back here what you sent and to whom.';
  }

  // Confirm row shown after the bot returns its agent recommendation(s). Clicking
  // sends the go-ahead; the bot then performs the delegate_task fan-out. roles is
  // the set captured at Start Building time, so the copy + the confirm prompt name
  // exactly the roles that are pending.
  function showHandoffConfirm(roles) {
    roles = roles || ['build'];
    var wantTest = roles.indexOf('test') !== -1;
    var existing = chatMessages.querySelector('.research-actions');
    if (existing) existing.remove();

    var actions = document.createElement('div');
    actions.className = 'research-actions';

    var confirmBtn = document.createElement('button');
    confirmBtn.innerHTML = '<span class="btn-icon">&#x1F91D;</span> Confirm Handoff (' + (wantTest ? 'build + test' : 'build') + ')';
    confirmBtn.onclick = function() {
      actions.classList.add('used');
      var paths = handoffPaths();
      chatInput.value = '<!-- prompt:confirmHandoff -->' + confirmHandoffPrompt(roles, paths.planPath, paths.specPath);
      sendMessage();
    };
    actions.appendChild(confirmBtn);

    var hint = document.createElement('span');
    hint.className = 'research-actions-hint';
    hint.textContent = wantTest
      ? 'or reply to name different build / test agents'
      : 'or reply with a different agent to hand off to';
    actions.appendChild(hint);

    chatMessages.appendChild(actions);
    scrollToBottom();
  }

  // The go-ahead prompt sent on Confirm Handoff: tells the bot to fan out via
  // delegate_task (NOT send_to_peer) once per pending role, with the per-role
  // instructions. delegate_task records each handoff against this thread's dev_run
  // and asks the peer to echo a run marker so its reply routes back precisely.
  function confirmHandoffPrompt(roles, planPath, specPath) {
    roles = roles || ['build'];
    var wantTest = roles.indexOf('test') !== -1;
    return 'Confirmed — proceed with the handoff now using the delegate_task tool (NOT send_to_peer), once per role (each call takes the params to, role, and a message) so each handoff is tracked under this dev run:\\n' +
      '- delegate_task(to: <recommended build agent>, role: "build", message: ...): the message points it at the work plan' + (planPath ? ' (' + planPath + ')' : '') + ' and instructs it to ' + handoffReviewInstruction() + '\\n' +
      (wantTest ? '- delegate_task(to: <recommended test agent>, role: "test", message: ...): the message points it at the domain spec' + (specPath ? ' (' + specPath + ')' : '') + ' and instructs it to ' + testHandoffInstruction(specPath, planPath) + '\\n' : '') +
      'Then report back here what you sent and to whom.';
  }

  // Fagperson review gate — shown after the Generate Spec reply (the domain spec
  // is already rendered above as a bot message). The reviewer approves to freeze
  // the spec (status → approved), saves a draft to revisit, or replies to refine
  // and regenerate. Catching wrong domain understanding here, before any code, is
  // the highest-value property of spec-first dev.
  function showSpecReview() {
    var existing = chatMessages.querySelector('.research-actions');
    if (existing) existing.remove();

    var actions = document.createElement('div');
    actions.className = 'research-actions';

    var approveBtn = document.createElement('button');
    approveBtn.innerHTML = '<span class="btn-icon">&#x2705;</span> Approve Spec';
    approveBtn.onclick = function() {
      actions.classList.add('used');
      saveDomainSpec(true);
    };
    actions.appendChild(approveBtn);

    var draftBtn = document.createElement('button');
    draftBtn.innerHTML = '<span class="btn-icon">&#x1F4BE;</span> Save Draft';
    draftBtn.onclick = function() {
      actions.classList.add('used');
      saveDomainSpec(false);
    };
    actions.appendChild(draftBtn);

    var hint = document.createElement('span');
    hint.className = 'research-actions-hint';
    hint.textContent = 'review the domain spec above — approve to freeze it, or reply to refine then regenerate';
    actions.appendChild(hint);

    chatMessages.appendChild(actions);
    scrollToBottom();
  }

  // Persist the generated domain spec (Phase 1). Pulls the bot reply that
  // followed the Generate Spec prompt (the latest one wins, so re-generating
  // then saving keeps the newest), wraps it in frontmatter, and POSTs to
  // /chat/specs. \`approved\` flips both the frontmatter status and the dev_run
  // status (spec_draft → spec_approved); the server links it to the dev_run.
  async function saveDomainSpec(approved) {
    if (!activeConvId || !activeThreadId || !selectedBot || !selectedUserId) return;
    var issueKey = researchIssueKey || ('research-' + activeThreadId.slice(0, 8));

    var url = '/chat/conversations/' + activeConvId + '/messages?raw=true';
    if (activeThreadId) url += '&thread=' + encodeURIComponent(activeThreadId);
    var res = await fetch(url);
    var data = await res.json();
    var msgs = data.messages || [];

    // The domain spec is the bot message right after the specDomain prompt.
    var domainSpec = '';
    var awaitingReply = false;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.sender === 'user' && m.text.indexOf('<!-- prompt:specDomain -->') === 0) {
        awaitingReply = true;
      } else if (awaitingReply && m.sender === 'bot') {
        domainSpec = m.text;
        awaitingReply = false;
      }
    }
    if (!domainSpec) { console.error('No domain spec reply found to save'); return; }

    var frontStatus = approved ? 'approved' : 'draft';
    var devRunStatus = approved ? 'spec_approved' : 'spec_draft';
    var now = new Date().toISOString().split('T')[0];
    var sections = [];
    sections.push('---');
    sections.push('jira: ' + issueKey);
    sections.push('bot: ' + selectedBot);
    sections.push('status: ' + frontStatus);
    sections.push('date: ' + now);
    sections.push('---');
    sections.push('');
    sections.push(domainSpec);
    var spec = sections.join('\\n');

    try {
      var saveRes = await fetch('/chat/specs/' + encodeURIComponent(selectedBot) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(issueKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: spec, status: devRunStatus }),
      });
      if (saveRes.ok) {
        specGenerated = true;
        // Approve flips the in-memory gate so the build+test fan-out unlocks in
        // THIS session (checkSpecStatus only re-derives it on reload). A plain
        // draft save never downgrades an approval — mirrors the server's
        // linkSpecToDevRun no-downgrade guard — so don't clear it here.
        if (approved) specApproved = true;
        if (!researchIssueKey) researchIssueKey = issueKey;
        // Return to the analysis action row (now with Save Spec available, and —
        // after approval — Start Building enabled), with a short-lived
        // confirmation of what just happened.
        showResearchActions('analysis');
        var row = chatMessages.querySelector('.research-actions');
        if (row) {
          var note = document.createElement('span');
          note.className = 'research-actions-hint';
          note.textContent = approved ? 'Spec approved' : 'Spec draft saved';
          row.appendChild(note);
          setTimeout(function() { if (note.parentNode) note.parentNode.removeChild(note); }, 2500);
        }
      } else {
        console.error('Failed to save spec: HTTP ' + saveRes.status);
      }
    } catch (err) {
      console.error('Failed to save spec:', err);
    }
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
        // Brief visual feedback on the Create Workplan button. Find it by label —
        // its position in the row shifts when the Generate Spec button is present,
        // so a fixed nth-child index would flash the wrong button.
        var btn = null;
        var rowBtns = chatMessages.querySelectorAll('.research-actions button');
        for (var bi = 0; bi < rowBtns.length; bi++) {
          if (rowBtns[bi].textContent.indexOf('Create Workplan') !== -1) { btn = rowBtns[bi]; break; }
        }
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
