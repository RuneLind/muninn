/**
 * The popup. Loaded as a MODULE (`popup.html`), so it can import the rules the
 * repo tests: `capture-rules.js` is emitted from
 * `src/youtube/extension-options-rules.ts` by `bun run build:extension`.
 * Nothing here re-implements a rule that lives there.
 */
import {
  FALLBACK_CAPTURE_OPTIONS,
  OPTIONS_UNREACHABLE_MESSAGE,
  parseCaptureOptions,
  pickFrames,
  pickKind,
  restoredKindNote,
} from './capture-rules.js';

const $ = (sel) => document.querySelector(sel);

// The Slides tick and the summary KIND, remembered per browser under the same
// sync storage the Muninn URL lives in. Slides default OFF (they cost a
// download, an ffmpeg pass and a multi-turn model session); the kind defaults to
// whatever the server calls its default, which is Standard.
const FRAMES_KEY = 'frames';
const KIND_KEY = 'summaryKind';

/** The Slides label's ordinary tooltip, restored when the tick is usable. */
const FRAMES_LABEL_TITLE =
  'Pull one frame per cadence tick (~20s on a 10-minute video, ~180s at the 3-hour cap) ' +
  'and let the summary quote the slides that add something the transcript does not say. ' +
  'Adds a download and a few minutes.';

let videoInfo = null;
/** What this Muninn offers. Replaced once the options endpoint answers. */
let captureOptions = FALLBACK_CAPTURE_OPTIONS;
/**
 * The two lines that explain the controls, held rather than written straight
 * out: the capture panel is revealed by an ASYNC callback, so whichever of the
 * two arrives second is what paints. Both are re-rendered from here.
 */
let optionsNote = '';
let framesNote = '';
/** Whether the capture panel is on screen — the panel the notes describe. */
let panelShown = false;

/**
 * Paint the explanatory lines, if there is a panel to paint them in.
 *
 * On a tab that is not a YouTube video — and in the window before the content
 * script has answered — `#video-info` is hidden, so a note written there is
 * invisible AND is about controls the reader cannot see. Nothing is shown until
 * the panel is.
 */
function renderNotes() {
  for (const [sel, text] of [['#options-note', optionsNote], ['#frames-note', framesNote]]) {
    const el = $(sel);
    el.textContent = panelShown ? text : '';
    el.classList.toggle('hidden', !panelShown || text === '');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // BEFORE any await. `populateControls` waits on the worker, whose options
  // fetch waits on a `muninnUrl` that can be a black hole — and until it
  // settled, neither Summarize nor Settings had a listener, so the one control
  // that could fix a wrong URL was dead exactly when it was needed.
  $('#btn-summarize').addEventListener('click', handleSummarize);
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state && state.videoId) {
      videoInfo = state;
      showVideoPage(state);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.url?.includes('youtube.com/watch')) {
          $('#not-video').classList.remove('hidden');
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, (info) => {
          if (info && info.videoId) {
            videoInfo = info;
            showVideoPage(info);
          } else {
            $('#not-video').classList.remove('hidden');
          }
        });
      });
    }
  });

  void populateControls();
});

/**
 * Ask the server what it offers, then restore the remembered choices against
 * THAT — never against a catalog of the extension's own, which would offer a
 * kind this Muninn cannot run and collect a 400 on click.
 *
 * A failed read is said out loud (`OPTIONS_UNREACHABLE_MESSAGE`) and leaves
 * Standard only. A silent Standard-only picker is the failure this endpoint
 * exists to remove.
 */
async function populateControls() {
  // The callback form: a worker that failed to answer leaves
  // `chrome.runtime.lastError` set and hands the callback `undefined`, which is
  // one of the shapes `parseCaptureOptions` refuses — so an unreachable Muninn
  // and a broken worker land in the same place.
  const answer = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_OPTIONS' }, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });

  const parsed = answer && !answer.error ? parseCaptureOptions(answer.options) : null;
  captureOptions = parsed ?? FALLBACK_CAPTURE_OPTIONS;
  optionsNote = captureOptions.fromServer ? '' : OPTIONS_UNREACHABLE_MESSAGE;

  const kindSelect = $('#sel-kind');
  kindSelect.replaceChildren(
    ...captureOptions.kinds.map((kind) => {
      const option = document.createElement('option');
      option.value = kind.id;
      option.textContent = kind.label;
      return option;
    }),
  );

  const frames = $('#chk-frames');
  frames.disabled = !captureOptions.framesSupported;
  // A dimmed control with no explanation reads as a bug. The reason is the
  // summarizer bot's CONNECTOR, which is a server fact the reader cannot infer.
  framesNote = frames.disabled
    ? "Slides are off: this Muninn's summarizer bot uses a connector that cannot read frames."
    : '';
  $('#lbl-frames').title = frames.disabled
    ? "Summarizer bot's connector cannot read frames."
    : FRAMES_LABEL_TITLE;

  // Restore, then persist every change. Both halves are guarded: a storage
  // failure must leave the button working, not the popup dead — the controls
  // then show this instance's defaults for that session.
  let stored = {};
  try {
    stored = await chrome.storage.sync.get({ [FRAMES_KEY]: false, [KIND_KEY]: null });
  } catch (err) {
    console.warn('Could not read the remembered capture settings', err);
  }
  const picked = pickKind(stored[KIND_KEY], captureOptions);
  kindSelect.value = picked;
  frames.checked = pickFrames(stored[FRAMES_KEY], captureOptions);

  // A remembered kind this instance no longer offers falls back silently
  // otherwise: the picker shows Standard and the reader reads the capture as
  // the kind they thought they had picked. Never shown under the unreachable
  // fallback — the line above is the true explanation there.
  optionsNote = optionsNote || (restoredKindNote(stored[KIND_KEY], picked, captureOptions) ?? '');
  renderNotes();

  kindSelect.addEventListener('change', () => {
    // The note explains a value the reader has now overridden.
    if (optionsNote && captureOptions.fromServer) {
      optionsNote = '';
      renderNotes();
    }
    chrome.storage.sync
      .set({ [KIND_KEY]: kindSelect.value })
      .catch((err) => console.warn('Could not save the summary kind', err));
  });
  frames.addEventListener('change', () => {
    chrome.storage.sync
      .set({ [FRAMES_KEY]: frames.checked })
      .catch((err) => console.warn('Could not save the Slides preference', err));
  });
}

function showVideoPage(state) {
  $('#video-title').textContent = state.title;
  $('#video-info').classList.remove('hidden');
  panelShown = true;
  // The options read may already have finished against a hidden panel.
  renderNotes();
}

async function handleSummarize() {
  const btn = $('#btn-summarize');
  const status = $('#status');

  btn.disabled = true;
  status.className = '';
  status.innerHTML = '<span class="spinner"></span>Submitting to dashboard...';
  status.classList.remove('hidden');

  try {
    // Re-fetch fresh video info from the content script
    const freshInfo = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return resolve(null);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, resolve);
      });
    });
    if (freshInfo && freshInfo.videoId) {
      videoInfo = freshInfo;
    }

    // Submit to Muninn — opens dashboard in new tab
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'SUMMARIZE',
        title: videoInfo.title,
        url: videoInfo.url,
        videoId: videoInfo.videoId,
        // Re-validated rather than read straight off the control: the options
        // can only have narrowed since they were rendered, and the route 400s
        // an id it does not offer.
        kind: pickKind($('#sel-kind').value, captureOptions),
        frames: pickFrames($('#chk-frames').checked, captureOptions),
      }, (response) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });

    if (result?.duplicate) {
      status.className = '';
      status.textContent = 'Already summarized — opening existing summary.';
      setTimeout(() => window.close(), 1200);
      return;
    }

    // Close the popup — the dashboard tab is open
    window.close();
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
    btn.disabled = false;
  }
}
