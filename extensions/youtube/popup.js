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
} from './capture-rules.js';

const $ = (sel) => document.querySelector(sel);

// The Slides tick and the summary KIND, remembered per browser under the same
// sync storage the Muninn URL lives in. Slides default OFF (they cost a
// download, an ffmpeg pass and a multi-turn model session); the kind defaults to
// whatever the server calls its default, which is Standard.
const FRAMES_KEY = 'frames';
const KIND_KEY = 'summaryKind';

let videoInfo = null;
/** What this Muninn offers. Replaced once the options endpoint answers. */
let captureOptions = FALLBACK_CAPTURE_OPTIONS;

document.addEventListener('DOMContentLoaded', async () => {
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

  await populateControls();

  $('#btn-summarize').addEventListener('click', handleSummarize);
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
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
  if (!captureOptions.fromServer) {
    const status = $('#status');
    status.className = 'error';
    status.textContent = OPTIONS_UNREACHABLE_MESSAGE;
    status.classList.remove('hidden');
  }

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

  // Restore, then persist every change. Both halves are guarded: a storage
  // failure must leave the button working, not the popup dead — the controls
  // then simply show this instance's defaults for that session.
  let stored = {};
  try {
    stored = await chrome.storage.sync.get({ [FRAMES_KEY]: false, [KIND_KEY]: null });
  } catch (err) {
    console.warn('Could not read the remembered capture settings', err);
  }
  kindSelect.value = pickKind(stored[KIND_KEY], captureOptions);
  frames.checked = pickFrames(stored[FRAMES_KEY], captureOptions);

  kindSelect.addEventListener('change', () => {
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

    // Close popup — dashboard tab is now open
    window.close();
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
    btn.disabled = false;
  }
}
