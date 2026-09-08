/**
 * The popup. Loaded as a MODULE (`popup.html`), so it can import the rules the
 * repo tests: `capture-rules.js` is emitted from
 * `src/youtube/extension-options-rules.ts` by `bun run build:extension`.
 * Nothing here re-implements a rule that lives there.
 *
 * ## One settle path
 *
 * Getting the controls ready reads two things that can each answer, fail, or
 * never answer at all — the options endpoint (through the worker) and
 * `chrome.storage.sync` — and then paints, which can throw. Two earlier rounds
 * patched one of those leaves at a time and each time the next reader found the
 * same class through a different door, so the state space is enumerated here
 * and ONE function owns every leaf of it:
 *
 * | options read | storage read | paint  | what settles                        |
 * |--------------|--------------|--------|-------------------------------------|
 * | answers      | answers      | ok     | server picker, remembered choice     |
 * | error        | any          | ok     | fallback picker + unreachable note   |
 * | times out    | any          | ok     | fallback picker + unreachable note   |
 * | never answers| any          | ok     | fallback picker + unreachable note   |
 * | any          | rejects      | ok     | picker on THIS instance's defaults + a note saying so |
 * | any          | hangs        | ok     | same                                 |
 * | any          | any          | throws | retried against the fallback; a second failure keeps Summarize disabled with a note |
 *
 * Three invariants hold on every row:
 *
 *  - **Summarize goes live only when the picker shows exactly what a click will
 *    submit.** That is why the button starts disabled: before the reads settle
 *    the picker is this instance's default and the remembered `deep`/`true` are
 *    not restored, so a click would submit a kind the reader did not pick.
 *  - **Whenever the picker is NOT showing what this browser remembered, a
 *    visible sentence says so** — the unreachable line, the "showing this
 *    instance's defaults" line, or `restoredKindNote`'s "not offered here".
 *    A silent fallback is the failure the options endpoint exists to remove.
 *  - **Settings is live from the first tick**, before any await: it is the one
 *    control that fixes the URL this popup may be hanging on.
 */
import {
  FALLBACK_CAPTURE_OPTIONS,
  OPTIONS_UNREACHABLE_MESSAGE,
  parseCaptureOptions,
  pickFrames,
  pickKind,
  pickVisualDetail,
  restoredKindNote,
} from './capture-rules.js';

const $ = (sel) => document.querySelector(sel);

// The Slides tick and the summary KIND, remembered per browser under the same
// sync storage the Muninn URL lives in. Slides default OFF (they cost a
// download, an ffmpeg pass and a multi-turn model session); the kind defaults to
// whatever the server calls its default, which is Standard.
const FRAMES_KEY = 'frames';
const KIND_KEY = 'summaryKind';
// How much of the video a slides capture may SHOW — a second axis, remembered
// separately from the kind. It is only ever consulted with Slides ticked, so it
// has no effect on a transcript-only capture and is remembered across both.
const VISUAL_KEY = 'visualDetail';

/**
 * The Slides label's ordinary tooltip, restored when the tick is usable — READ
 * off `popup.html` rather than spelled out again here, so the sentence a reader
 * hovers exists in one place. A module script runs after parsing, so the label
 * is on the page — but the read is still guarded: a module that throws at
 * evaluation registers NO listeners at all, which is a dead popup rather than a
 * missing tooltip. Every other id this file reads is guarded for the same
 * reason.
 */
const FRAMES_LABEL_TITLE = $('#lbl-frames')?.title ?? '';

/**
 * How long the remembered choices get to arrive before the controls go live on
 * this instance's defaults. `chrome.storage.sync.get` is a round trip to the
 * profile's sync backend and is not otherwise bounded — and Summarize stays
 * disabled until it settles, so an unbounded wait there is a dead popup.
 */
const STORAGE_READ_TIMEOUT_MS = 2000;

/**
 * How long the worker gets to answer `GET_OPTIONS`. Slightly above the 4s
 * budget `background.js` puts on its own fetch, so the worker's own timeout is
 * what normally reports the failure and this is only reached when the worker
 * answers nothing at all: an `onMessage` handler that returned `true` and then
 * lost its promise (a service worker torn down mid-flight, an exception outside
 * the `.catch`) leaves `sendResponse` uncalled forever, and the callback this
 * popup is waiting on is simply never invoked.
 */
const OPTIONS_READ_TIMEOUT_MS = 5000;

/** Said when the remembered choices could not be read at all. */
const STORAGE_LOST_MESSAGE =
  "Could not read the remembered Kind, Slides tick and Visuals choice — showing this Muninn's defaults.";

/** Said when the controls themselves could not be painted. */
const CONTROLS_BROKEN_MESSAGE =
  'Could not render the capture controls — reopen the popup, or check Settings.';

/** Why the Slides tick is dimmed, when it is. */
const FRAMES_UNSUPPORTED_NOTE =
  "Slides are off: this Muninn's summarizer bot uses a connector that cannot read frames.";
const FRAMES_UNSUPPORTED_TITLE = "Summarizer bot's connector cannot read frames.";

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
/** Whether {@link settle} has already run. It runs once. */
let settled = false;
/** Whether the persist-on-change listeners are attached. They attach once. */
let listenersAttached = false;

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
    if (!el) continue;
    el.textContent = panelShown ? text : '';
    el.classList.toggle('hidden', !panelShown || text === '');
  }
}

/**
 * Show the Visuals row exactly while it means something: this instance offers
 * the choice AND slides are ticked. With no frames there is nothing to choose
 * between, and a control that is always there reads as a setting that always
 * applies.
 */
function renderVisualRow() {
  const label = $('#lbl-visual');
  if (!label) return;
  const ticked = $('#chk-frames')?.checked === true;
  label.classList.toggle('hidden', !(ticked && captureOptions.visualDetail));
}

document.addEventListener('DOMContentLoaded', () => {
  // BEFORE any await. `loadControls` waits on the worker, whose options fetch
  // waits on a `muninnUrl` that can be a black hole — and until it settled,
  // neither Summarize nor Settings had a listener, so the one control that
  // could fix a wrong URL was dead exactly when it was needed.
  const summarize = $('#btn-summarize');
  if (summarize) {
    summarize.addEventListener('click', handleSummarize);
    // Disabled until `settle` runs — success, unreachable fallback, storage
    // failure, render failure alike. Before that the picker is this instance's
    // default and the remembered kind and tick have not been restored, so a
    // click inside the window the options read owns submits `{kind:"standard",
    // frames:false}` over a storage that says `deep` and `true`: the wrong-kind
    // capture the server-side 400 exists to prevent, arriving from the client.
    summarize.disabled = true;
  }
  // Settings stays live throughout — see the module comment's third invariant.
  $('#open-options')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // The floor the settle path falls back onto: a Standard-only picker, painted
  // synchronously so the select is never empty and never shows a kind that is
  // not what a click would submit. It carries NO change listeners — those go on
  // in `settle`, because a change handler here would persist `standard` over a
  // remembered `deep` if the reader touched the picker before the reads landed.
  try {
    paintControls({ options: FALLBACK_CAPTURE_OPTIONS, stored: {}, notes: [] });
  } catch (err) {
    console.warn('Could not paint the initial capture controls', err);
  }

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state && state.videoId) {
      videoInfo = state;
      showVideoPage(state);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.url?.includes('youtube.com/watch')) {
          $('#not-video')?.classList.remove('hidden');
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, (info) => {
          if (info && info.videoId) {
            videoInfo = info;
            showVideoPage(info);
          } else {
            $('#not-video')?.classList.remove('hidden');
          }
        });
      });
    }
  });

  void loadControls();
});

/** Resolve to `fallback` when `promise` has not settled within `ms`. */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Distinguishable from every value either read can legitimately produce. */
const TIMED_OUT = Symbol('timed out');
const STORAGE_FAILED = Symbol('storage failed');

/**
 * Ask the server what it offers and this browser what it remembered, and answer
 * with the outcome — never throwing for either read, so every row of the table
 * in the module comment reaches {@link settle} the same way.
 *
 * The options are asked for FIRST because the remembered kind is re-validated
 * against them: restoring `deep` blind on an instance that does not offer it is
 * a 400 on click.
 */
async function readControlState() {
  const notes = [];

  let answer;
  try {
    answer = await withTimeout(
      new Promise((resolve) => {
        // The callback form: a worker that failed to answer leaves
        // `chrome.runtime.lastError` set and hands the callback `undefined`,
        // which is one of the shapes `parseCaptureOptions` refuses — so an
        // unreachable Muninn and a broken worker land in the same place. A
        // worker that answers NOTHING never invokes this callback at all, which
        // is what the timeout is for.
        chrome.runtime.sendMessage({ type: 'GET_OPTIONS' }, (response) => {
          void chrome.runtime.lastError;
          resolve(response);
        });
      }),
      OPTIONS_READ_TIMEOUT_MS,
      TIMED_OUT,
    );
  } catch (err) {
    // `sendMessage` throws synchronously when the extension context has been
    // invalidated (the extension reloaded while this popup was open).
    console.warn('Could not ask the worker for the capture options', err);
    answer = TIMED_OUT;
  }

  const parsed =
    answer && answer !== TIMED_OUT && !answer.error ? parseCaptureOptions(answer.options) : null;
  const options = parsed ?? FALLBACK_CAPTURE_OPTIONS;
  if (!options.fromServer) notes.push(OPTIONS_UNREACHABLE_MESSAGE);

  let read;
  try {
    read = await withTimeout(
      // Every key this popup restores is NAMED here. The object form of
      // `chrome.storage.sync.get` answers with the shape's keys and nothing
      // else, so a key left out of it reads back `undefined` however much the
      // profile has stored — a remembered choice silently replaced by this
      // instance's default.
      Promise.resolve(
        chrome.storage.sync.get({ [FRAMES_KEY]: false, [KIND_KEY]: null, [VISUAL_KEY]: null }),
      ).catch(
        (err) => {
          console.warn('Could not read the remembered capture settings', err);
          return STORAGE_FAILED;
        },
      ),
      STORAGE_READ_TIMEOUT_MS,
      STORAGE_FAILED,
    );
  } catch (err) {
    console.warn('Could not read the remembered capture settings', err);
    read = STORAGE_FAILED;
  }

  // The read failing is not the same as nothing being stored. Falling back to
  // `{}` renders this instance's defaults over a storage that may hold `deep`
  // and `true` — which is the picker showing something other than the reader's
  // remembered choice, so it is said out loud.
  const failed = read === STORAGE_FAILED || read === null || typeof read !== 'object';
  if (failed) notes.push(STORAGE_LOST_MESSAGE);

  return { options, stored: failed ? {} : read, notes };
}

async function loadControls() {
  try {
    settle(await readControlState());
  } catch (err) {
    // `readControlState` guards both reads, so this is the last resort: settle
    // on the fallback rather than leave the button dead.
    console.warn('Could not read the capture options', err);
    settle({
      options: FALLBACK_CAPTURE_OPTIONS,
      stored: {},
      notes: [OPTIONS_UNREACHABLE_MESSAGE],
    });
  }
}

/**
 * The ONE place the controls become usable. Every row of the table in the
 * module comment ends here, and nothing else touches `#btn-summarize.disabled`
 * after the initial disable.
 *
 * A paint that throws is retried against the fallback options, because a
 * half-painted picker shows kinds that {@link pickKind} would no longer submit.
 * If that retry fails too, the button deliberately STAYS disabled with a
 * visible sentence: at that point the popup cannot show what a click would
 * submit, which is the one thing enabling it is supposed to guarantee. Settings
 * is still live, and the state is settled — no read is still outstanding.
 */
function settle(outcome) {
  if (settled) return;
  settled = true;

  let painted = false;
  try {
    painted = paintControls(outcome);
  } catch (err) {
    console.warn('Could not paint the capture controls', err);
  }
  if (!painted) {
    try {
      painted = paintControls({
        options: FALLBACK_CAPTURE_OPTIONS,
        stored: {},
        notes: [...outcome.notes, CONTROLS_BROKEN_MESSAGE],
      });
    } catch (err) {
      console.warn('Could not paint the fallback capture controls', err);
    }
  }
  if (!painted) {
    captureOptions = FALLBACK_CAPTURE_OPTIONS;
    optionsNote = CONTROLS_BROKEN_MESSAGE;
    try {
      renderNotes();
    } catch (err) {
      console.warn('Could not render the capture notes', err);
    }
    return;
  }

  attachControlListeners();
  const btn = $('#btn-summarize');
  if (btn) btn.disabled = false;
}

/**
 * Paint the picker, the tick and the notes from one outcome. Synchronous and
 * total: it either leaves the controls coherent and returns true, or it throws
 * / returns false and the caller repaints the fallback.
 *
 * Both nodes are resolved before anything is written, and the option elements
 * are all built before the select is touched, so the picker is never left
 * half-painted: on a throw it still holds the last list that was coherent with
 * `captureOptions`, and the caller repaints the fallback over it.
 */
function paintControls({ options, stored, notes }) {
  const kindSelect = $('#sel-kind');
  const frames = $('#chk-frames');
  if (!kindSelect || !frames) return false;

  captureOptions = options;

  kindSelect.replaceChildren(
    ...options.kinds.map((kind) => {
      const option = document.createElement('option');
      option.value = kind.id;
      option.textContent = kind.label;
      return option;
    }),
  );
  const picked = pickKind(stored[KIND_KEY], options);
  kindSelect.value = picked;

  frames.disabled = !options.framesSupported;
  frames.checked = pickFrames(stored[FRAMES_KEY], options);

  // The visuals picker, on the instances that offer one. Guarded rather than
  // required, the `#lbl-frames` rule: a missing node must cost the reader that
  // one control, never the whole popup.
  const visualSelect = $('#sel-visual');
  if (visualSelect && captureOptions.visualDetail) {
    visualSelect.replaceChildren(
      ...captureOptions.visualDetail.options.map((row) => {
        const option = document.createElement('option');
        option.value = row.id;
        option.textContent = row.label;
        return option;
      }),
    );
    const detail = pickVisualDetail(stored[VISUAL_KEY], captureOptions);
    if (detail) visualSelect.value = detail;
  }
  renderVisualRow();

  // A dimmed control with no explanation reads as a bug. The reason is the
  // summarizer bot's CONNECTOR, which is a server fact the reader cannot infer.
  framesNote = frames.disabled ? FRAMES_UNSUPPORTED_NOTE : '';
  const label = $('#lbl-frames');
  if (label) label.title = frames.disabled ? FRAMES_UNSUPPORTED_TITLE : FRAMES_LABEL_TITLE;

  // A remembered kind this instance no longer offers falls back silently
  // otherwise: the picker shows Standard and the reader reads the capture as
  // the kind they thought they had picked. Never shown under the unreachable
  // fallback — that line is the true explanation there, and `restoredKindNote`
  // returns null for it.
  const restored = restoredKindNote(stored[KIND_KEY], picked, options);
  optionsNote = [...notes, ...(restored ? [restored] : [])].join(' ');
  renderNotes();
  return true;
}

/**
 * Persist every change, once the controls are live. Attached after the paint,
 * never before: a change handler on the pre-settle picker would write this
 * instance's default over a remembered `deep` the moment the reader touched it.
 */
function attachControlListeners() {
  if (listenersAttached) return;
  const kindSelect = $('#sel-kind');
  const frames = $('#chk-frames');
  if (!kindSelect || !frames) return;
  listenersAttached = true;

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
    // Ticking Slides is what reveals the Visuals row, so the paint and this
    // listener both go through `renderVisualRow` rather than each toggling the
    // class on their own.
    renderVisualRow();
    chrome.storage.sync
      .set({ [FRAMES_KEY]: frames.checked })
      .catch((err) => console.warn('Could not save the Slides preference', err));
  });
  const visualSelect = $('#sel-visual');
  visualSelect?.addEventListener('change', () => {
    // The element, not `ev.target` — the same shape the kind listener uses, and
    // the one that does not depend on how the event was dispatched.
    chrome.storage.sync
      .set({ [VISUAL_KEY]: visualSelect.value })
      .catch((err) => console.warn('Could not save the visual detail preference', err));
  });
}

function showVideoPage(state) {
  const title = $('#video-title');
  if (title) title.textContent = state.title;
  $('#video-info')?.classList.remove('hidden');
  panelShown = true;
  // The options read may already have finished against a hidden panel.
  renderNotes();
}

async function handleSummarize() {
  const btn = $('#btn-summarize');
  const status = $('#status');
  const kindSelect = $('#sel-kind');
  const frames = $('#chk-frames');
  const visualSelect = $('#sel-visual');
  // Read once: the frames answer decides both the field it is sent as and
  // whether the visual-detail field is sent at all.
  const wantsFrames = pickFrames(frames?.checked, captureOptions);

  if (btn) btn.disabled = true;
  if (status) {
    status.className = '';
    status.innerHTML = '<span class="spinner"></span>Submitting to dashboard...';
    status.classList.remove('hidden');
  }

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
        kind: pickKind(kindSelect?.value, captureOptions),
        frames: wantsFrames,
        // Null on an instance that does not offer the choice, and null with
        // Slides OFF — the worker then sends no such field. The picker is
        // hidden without frames, so its value there is whatever the last paint
        // left in a hidden control, and the policy is consulted only where
        // frames came out. Sending it anyway would put a value on the trace and
        // in the 400 surface that nothing this capture did could depend on.
        visualDetail: wantsFrames ? pickVisualDetail(visualSelect?.value, captureOptions) : null,
      }, (response) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });

    if (result?.duplicate) {
      if (status) {
        status.className = '';
        status.textContent = 'Already summarized — opening existing summary.';
      }
      setTimeout(() => window.close(), 1200);
      return;
    }

    // Close the popup — the dashboard tab is open
    window.close();
  } catch (err) {
    if (status) {
      status.className = 'error';
      status.textContent = err.message;
    }
    if (btn) btn.disabled = false;
  }
}
