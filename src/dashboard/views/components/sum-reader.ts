/** Summaries doc panel — the article as a reader: header menu, hero, outline.
 *
 * The DOM half of `src/summaries/reader-article.ts`, whose pure functions are
 * injected here with `.toString()` (the Latest rail's pattern). It owns:
 *
 *  - the header's `⋯ More` menu (`docPanelHtml({moreMenu:true})`): Export,
 *    Copy link and Delete, joined to the panel's Escape chain in
 *    sum-article-library.ts;
 *  - the article column's markup (`readerArticleHtml`): hero thumbnail and
 *    pills, the TL;DR lede, the Key takeaways card, the summary, the
 *    transcript `<details>` and the newer/older links;
 *  - the right rail's "On this page" outline with scroll-spy;
 *  - the Similar cards (`readerSimilarHtml`).
 *
 * It shares the page scope with sum-article-library.ts (openSummaryDoc,
 * renderMarkdown, splitTranscript, mapProseLines, linkVimeoTimestamps, getSummaryDocuments,
 * matchesDomain, docTitle, SOURCES, esc, _docRequestId, _shareDoc,
 * docPanelMenu), sum-shelf.ts (isShelfDoc) and sum-latest-rail.ts (railKey,
 * railCompare, railFilter, railReadState, railHidesDeleted, _railQuery,
 * _railChip, and the railDate/railValidDay the injected functions call);
 * every read of the rail's state is guarded, so the article renders without
 * it.
 */

import { READER_FUNCTIONS, READER_IMPORTS, READER_STALE_DAYS } from "../../../summaries/reader-article.ts";
import { copyText } from "./copy-path.ts";
import {
  DOC_PANEL_COPY_LINK_ID,
  DOC_PANEL_DELETE_BTN_ID,
  DOC_PANEL_EXPORT_LINK_ID,
  DOC_PANEL_MORE_BTN_ID,
  DOC_PANEL_MORE_MENU_ID,
} from "./doc-panel.ts";

/** How long the Similar fetch waits after an open, so `j`/`k` stepping
 *  through the rail does not queue one search per row passed. */
export const SIMILAR_DEBOUNCE_MS = 250;

export function sumReaderStyles(): string {
  return `
    /* --- Reader: the article hero, TL;DR, takeaways card, outline, cards --- */
    .sum-hero { display: flex; gap: 16px; align-items: flex-start; margin: 0 0 20px; }
    .sum-hero-thumb {
      flex-shrink: 0;
      width: 240px;
      aspect-ratio: 16 / 9;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
    }
    .doc-panel-body .sum-pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .doc-panel-body .sum-pills li { margin: 0; }
    .sum-pill {
      display: inline-flex;
      align-items: baseline;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 12px;
      border: 1px solid var(--border-secondary);
      background: var(--bg-card);
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.5;
    }
    .sum-pill-k { color: var(--text-soft); font-size: 11px; }
    .sum-pill-est { color: var(--text-soft); font-size: 11px; font-style: italic; }
    .sum-tldr {
      margin: 0 0 24px;
      padding: 12px 16px;
      border-left: 3px solid var(--accent);
      border-radius: 0 8px 8px 0;
      background: color-mix(in srgb, var(--accent) 8%, var(--bg-page));
      color: var(--text-primary);
    }
    .sum-tldr-k {
      display: block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: var(--accent-light);
      margin-bottom: 4px;
    }
    .doc-panel-body .sum-tldr p { margin: 0; }
    .sum-takeaways {
      margin: 0 0 24px;
      padding: 4px 18px 8px;
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      background: var(--bg-card);
    }
    .doc-panel-body .sum-takeaways h2 { margin-top: 12px; }
    /* contain: inline-size on the two blocks that hold nowrap titles: their
       min-content otherwise sized the one-column narrow grid (measured at
       390px: the nav 677px, the Similar column 494px, so the page scrolled
       sideways). */
    .sum-article-nav { display: flex; gap: 12px; margin-top: 32px; contain: inline-size; }
    #sumRightRail { contain: inline-size; }
    .sum-article-nav[hidden] { display: none; }
    .doc-panel-body a.sum-nav-link {
      flex: 1 1 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 14px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      color: var(--text-secondary);
      text-decoration: none;
    }
    .doc-panel-body a.sum-nav-link:hover { border-color: var(--accent); color: var(--text-primary); text-decoration: none; }
    .sum-nav-older { text-align: right; margin-left: auto; }
    /* Newer/Older move focus here (tabindex -1), so Tab continues in the
       article; the column itself needs no ring. */
    .sum-col-main:focus { outline: none; }
    /* A wide table scrolls in its own box, and a long inline code span
       wraps: at 390px either one scrolled the page sideways. */
    .sum-table-scroll { overflow-x: auto; margin: 0 0 16px; }
    .doc-panel-body .sum-table-scroll table { margin: 0; }
    #sumArticleMain :not(pre) > code { overflow-wrap: anywhere; }
    .sum-nav-k { font-size: 11px; color: var(--text-soft); }
    .sum-nav-t { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Right rail: the outline above Similar. */
    .sum-outline { margin: 0 0 18px; }
    .sum-outline[hidden] { display: none; }
    /* Scoped past .doc-panel-body ol, the markdown rule that indents lists. */
    .doc-panel-body .sum-outline-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
    .doc-panel-body .sum-outline-list li { margin: 0; }
    .sum-col-right a.sum-outline-link {
      display: block;
      padding: 4px 8px;
      border-left: 2px solid transparent;
      border-radius: 0 4px 4px 0;
      font-size: 12.5px;
      line-height: 1.35;
      color: var(--text-secondary);
      text-decoration: none;
    }
    .sum-col-right a.sum-outline-link:hover { background: var(--bg-hover); color: var(--text-primary); }
    .sum-col-right a.sum-outline-link.active { border-left-color: var(--accent); color: var(--accent-light); font-weight: 600; }
    .sum-outline-transcript { margin-top: 6px; }
    /* Similar cards: each card is one link. */
    .doc-similar-item.sum-sim-card { display: flex; gap: 10px; padding: 8px 0; color: inherit; text-decoration: none; }
    .doc-similar-item.sum-sim-card:hover { text-decoration: none; }
    .sum-sim-title { color: var(--accent-light); font-size: 13px; line-height: 1.4; }
    .sum-sim-card:hover .sum-sim-title { text-decoration: underline; }
    .sum-sim-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    .sum-sim-thumb {
      flex-shrink: 0;
      align-self: flex-start;
      width: 72px;
      aspect-ratio: 16 / 9;
      object-fit: cover;
      border-radius: 4px;
      background: var(--bg-surface);
    }
    .sum-sim-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .sum-sim-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-soft); }
    .sum-sim-bar { flex: 0 0 48px; height: 4px; border-radius: 2px; background: var(--border-primary); overflow: hidden; }
    .sum-sim-bar > span { display: block; height: 100%; background: var(--accent); }
    .sum-sim-card .doc-similar-relevance { margin-left: 0; color: var(--text-soft); }
    .sum-sim-age.stale { color: color-mix(in srgb, var(--status-warning) 65%, var(--text-primary)); }
    .sum-sim-why { display: block; font-size: 11px; color: var(--text-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sum-sim-tag {
      display: inline-block;
      margin-right: 4px;
      padding: 0 5px;
      border-radius: 4px;
      border: 1px solid var(--border-secondary);
      font-size: 10px;
      color: var(--text-soft);
    }
    @media (max-width: 1000px) {
      /* Below the breakpoint the rail sits after the article, where an
         outline of what is above it has nothing left to jump to. */
      .sum-outline { display: none; }
      /* Centred, the column took its content's min-content width: a quoted
         slide measured 429px at a 390px viewport. Stretched, max-width:100%
         on images and the pre blocks' own scrolling hold it to the column. */
      .sum-col-main { justify-self: stretch; }
    }
    @media (max-width: 700px) {
      .sum-hero { flex-direction: column; }
      .sum-hero-thumb { width: 100%; max-width: 360px; }
      /* The header's controls wrap under Back and the title. */
      .doc-panel-header { flex-wrap: wrap; row-gap: 8px; }
      .doc-panel-title { flex: 1 1 calc(100% - 90px); }
    }
  `;
}

export function sumReaderScript(): string {
  return `
    // --- Reader: pure logic, injected from src/summaries/reader-article.ts ---
    // --- reader-fns:start ---
    var READER_STALE_DAYS = ${READER_STALE_DAYS};
${[...READER_IMPORTS, ...READER_FUNCTIONS].map((fn) => `    var ${fn.name} = ${fn.toString()};`).join("\n")}
    // --- reader-fns:end ---
    // The clipboard write the dashboard's copy controls share (copy-path.ts).
    var copyText = ${copyText.toString()};

    function readerToday() { return new Date().toISOString().slice(0, 10); }

    // --- ⋯ More (docPanelHtml({moreMenu:true})): click, click-away, keys,
    // placement and Escape through docPanelMenu (doc-panel-menu.ts). ---
    var _moreMenu = docPanelMenu({
      btnId: '${DOC_PANEL_MORE_BTN_ID}',
      popId: '${DOC_PANEL_MORE_MENU_ID}',
      onOpen: function(menu) {
        var copy = document.getElementById('${DOC_PANEL_COPY_LINK_ID}');
        if (copy) copy.textContent = '🔗 Copy link';
        menu.focusItem(0);
      },
    });

    /** The /summaries deep link to the open summary — the shape the page's
     *  init reads (doc + source). */
    function readerDocLink() {
      if (!_shareDoc) return '';
      return location.origin + '/summaries?doc=' + encodeURIComponent(_shareDoc.docId) +
        '&source=' + encodeURIComponent(_shareDoc.source);
    }

    (function() {
      // Export downloads and Delete asks first; either way the menu has done
      // its job. Copy link stays open to say it copied.
      var exp = document.getElementById('${DOC_PANEL_EXPORT_LINK_ID}');
      if (exp) exp.addEventListener('click', function() { _moreMenu.close(true); });
      var del = document.getElementById('${DOC_PANEL_DELETE_BTN_ID}');
      if (del) del.addEventListener('click', function() { _moreMenu.close(true); });
      var copy = document.getElementById('${DOC_PANEL_COPY_LINK_ID}');
      if (copy) copy.addEventListener('click', function() {
        var link = readerDocLink();
        if (!link) return;
        copyText(link).then(function(ok) {
          copy.textContent = ok ? '✓ Link copied' : '✕ Copy failed';
          // The execCommand path selects a textarea it then removes, which
          // leaves focus on <body> with the menu still open.
          if (_moreMenu.isOpen()) copy.focus();
        });
      });
    })();

    // --- The article column ---
    var _readerDoc = null;     // {docId, source, requestId, url, thumb} of the open article
    var _readerSpyWired = false;
    var _readerSpyFrame = 0;
    // {id, top}: the outline entry just clicked, and the scrollTop its jump
    // landed on. It stays the active entry until the body scrolls elsewhere.
    var _readerSpyPin = null;

    function readerPillsHtml(pills) {
      if (!pills.length) return '';
      return '<ul class="sum-pills" aria-label="About this summary">' + pills.map(function(p) {
        return '<li class="sum-pill" data-pill="' + esc(p.key) + '"' +
          (p.estimated ? ' title="Estimated from the start of the transcript\\u2019s last window"' : '') + '>' +
          '<span class="sum-pill-k">' + esc(p.label) + '</span>' +
          '<span class="sum-pill-v">' + esc(p.value) + '</span>' +
          (p.estimated ? '<span class="sum-pill-est">est.</span>' : '') +
        '</li>';
      }).join('') + '</ul>';
    }

    /** The hero's and a card's thumbnail. \`src\` comes from readerThumbnail
     *  (https only); a video YouTube no longer serves answers 404, and the
     *  image goes rather than leaving a broken-image box. */
    function readerThumbHtml(src, cls) {
      return src ? '<img class="' + cls + '" src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '';
    }

    /**
     * The article column for one stored document. \`cleaned\` is the text
     * before any link transform: the pills, lede and outline read it as
     * stored, and the timestamp links are applied here, after the split.
     */
    function readerArticleHtml(cleaned, ctx) {
      var meta = ctx.meta || {};
      var raw = splitTranscript(cleaned);
      var src = SOURCES[ctx.source];
      var pillInput = {
        sourceLabel: src ? src.badge : null,
        date: meta.date,  // the listing row's date fills in later (readerRefreshNav)
        today: readerToday(),
        kind: meta.summary_kind,
        category: meta.category,
        author: meta.author,
        uploadDate: meta.upload_date,
        durationSec: meta.duration_sec,
        body: raw.body,
        transcript: raw.transcript,
      };
      ctx.pillInput = pillInput;
      var pills = readerPills(pillInput);
      var thumb = readerThumbnail(ctx.source, ctx.videoUrl, meta.thumbnail_url);
      var linked = cleaned;
      if (ctx.source === 'vimeo') linked = linkVimeoTimestamps(linked, ctx.videoUrl);
      if (ctx.source === 'youtube') linked = linkYouTubeTimestamps(linked, ctx.videoUrl);
      var parts = splitTranscript(linked);
      var lede = readerLede(parts.body);
      var body = lede ? lede.rest : parts.body;
      var tk = readerTakeaways(body);
      var hero = (thumb || pills.length)
        // A <div>, not a <header>: the shared page styles paint every header.
        ? '<div class="sum-hero" id="sumHero">' + readerThumbHtml(thumb, 'sum-hero-thumb') + readerPillsHtml(pills) + '</div>'
        : '';
      var tldr = lede
        ? '<aside class="sum-tldr" aria-label="TL;DR"><span class="sum-tldr-k">TL;DR</span>' + renderMarkdown(lede.text) + '</aside>'
        : '';
      var bodyHtml = tk
        ? renderMarkdown(tk.before) + '<section class="sum-takeaways">' + renderMarkdown(tk.section) + '</section>' + renderMarkdown(tk.after)
        : renderMarkdown(body);
      return hero + tldr +
        '<div class="sum-article-body" id="sumArticleBody">' + bodyHtml + '</div>' +
        (parts.transcript === null ? '' :
          '<details class="sum-transcript" id="sumTranscript"><summary>Transcript</summary>' +
            '<div class="sum-transcript-body">' + renderMarkdown(parts.transcript) + '</div>' +
          '</details>') +
        '<nav class="sum-article-nav" id="sumArticleNav" aria-label="Newer and older summaries" hidden></nav>';
    }

    /** The anchors a timestamp transform wrote open the video in a new tab. */
    function readerTimestampLinksInNewTab(container, source, videoUrl) {
      if (!container || source !== 'youtube') return;
      var id = readerYouTubeId(videoUrl);
      if (!id) return;
      var prefix = readerYouTubeStampBase(id);
      container.querySelectorAll('a[href]').forEach(function(a) {
        if (a.getAttribute('href').indexOf(prefix) === 0) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener');
        }
      });
    }

    /** After the article is in the DOM: heading ids and the outline, the
     *  scroll-spy, the new-tab timestamp links, and the newer/older links. */
    function readerAfterRender(mainEl, cleaned, ctx) {
      _readerDoc = {
        docId: ctx.docId, source: ctx.source, requestId: ctx.requestId, url: ctx.videoUrl,
        hasThumb: !!mainEl.querySelector('.sum-hero-thumb'), pillInput: ctx.pillInput || null,
      };
      _readerSpyPin = null;
      readerTimestampLinksInNewTab(mainEl, ctx.source, ctx.videoUrl);
      // Every table in its own scrolling box (.sum-table-scroll).
      mainEl.querySelectorAll('table').forEach(function(t) {
        if (t.parentElement && t.parentElement.classList.contains('sum-table-scroll')) return;
        var box = document.createElement('div');
        box.className = 'sum-table-scroll';
        t.parentNode.insertBefore(box, t);
        box.appendChild(t);
      });
      var outline = readerOutline(splitTranscript(cleaned).body);
      var level = outline.length ? outline[0].level : 0;
      var bodyEl = document.getElementById('sumArticleBody');
      var heads = level && bodyEl
        ? Array.prototype.filter.call(bodyEl.querySelectorAll('h' + level), function(h) { return !h.closest('blockquote, li'); })
        : [];
      var items = heads.map(function(h, i) {
        h.id = 'sum-sec-' + i;
        h.setAttribute('tabindex', '-1');
        // The rendered text when the markdown walk and the DOM disagree.
        var text = heads.length === outline.length ? outline[i].text : (h.textContent || '').trim();
        return '<li><a class="sum-outline-link" href="#sum-sec-' + i + '" data-target="sum-sec-' + i + '">' + esc(text) + '</a></li>';
      });
      var nav = document.getElementById('sumOutline');
      if (nav) {
        var hasTranscript = !!document.getElementById('sumTranscript');
        if (!items.length && !hasTranscript) {
          nav.hidden = true;
          nav.innerHTML = '';
        } else {
          nav.innerHTML = '<div class="sum-side-title">On this page</div>' +
            (items.length ? '<ol class="sum-outline-list">' + items.join('') + '</ol>' : '') +
            (hasTranscript ? '<a class="sum-outline-link sum-outline-transcript" href="#sumTranscript" data-target="sumTranscript">Transcript</a>' : '');
          nav.hidden = false;
        }
      }
      readerWireSpy();
      readerSpy();
      readerRefreshNav();
    }

    /** Wired once: outline clicks (open the transcript first when that is
     *  the target) and the scroll-spy on the panel body. */
    function readerWireSpy() {
      if (_readerSpyWired) return;
      var scroller = document.getElementById('docPanelBody');
      if (!scroller) return;
      _readerSpyWired = true;
      scroller.addEventListener('scroll', function() {
        if (_readerSpyFrame) return;
        _readerSpyFrame = requestAnimationFrame(function() { _readerSpyFrame = 0; readerSpy(); });
      }, { passive: true });
      scroller.addEventListener('click', function(e) {
        var link = e.target.closest && e.target.closest('#sumOutline a.sum-outline-link');
        if (!link) {
          var nl = e.target.closest && e.target.closest('#sumArticleNav a.sum-nav-link');
          if (!nl || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          var opened = openSummaryDoc(nl.getAttribute('data-doc-id'), nl.getAttribute('data-doc-url'), nl.getAttribute('data-source'));
          var req = _docRequestId;
          // The link that had focus is gone with the old article: focus the
          // new one, so Tab continues in it rather than from <body>. Only when
          // focus is still on the link or was dropped with it: a reader who
          // moved focus while the summary loaded keeps it there.
          Promise.resolve(opened).then(function() {
            if (req !== _docRequestId) return;
            var at = document.activeElement;
            if (at && at !== document.body && at !== nl) return;
            var main = document.getElementById('sumArticleMain');
            if (!main) return;
            main.setAttribute('tabindex', '-1');
            main.focus({ preventScroll: true });
          });
          return;
        }
        var target = document.getElementById(link.getAttribute('data-target'));
        if (!target) return;
        e.preventDefault();
        if (target.tagName === 'DETAILS') {
          target.open = true;
          var sum = target.querySelector('summary');
          target.scrollIntoView({ block: 'start' });
          if (sum) sum.focus({ preventScroll: true });
        } else {
          target.scrollIntoView({ block: 'start' });
          target.focus({ preventScroll: true });
        }
        // A short last section cannot scroll to the top, so geometry alone
        // would mark the one above it: the clicked entry is the active one.
        _readerSpyPin = { id: target.id, top: scroller.scrollTop };
        readerSpy();
      });
    }

    /**
     * Marks the outline entry of the section the reader is in: the last
     * target whose top has passed a line a quarter down the panel body. Over
     * the last screen of scrolling that line sweeps down to the bottom edge,
     * so short final sections are reached too and, at the bottom, the last
     * heading in view is the active one. A just-clicked entry wins until the
     * body scrolls away from where its jump landed.
     */
    function readerSpy() {
      var nav = document.getElementById('sumOutline');
      var scroller = document.getElementById('docPanelBody');
      if (!nav || nav.hidden || !scroller) return;
      var links = nav.querySelectorAll('a.sum-outline-link');
      var active = null;
      if (_readerSpyPin && Math.abs(scroller.scrollTop - _readerSpyPin.top) <= 2) {
        active = nav.querySelector('a.sum-outline-link[data-target="' + _readerSpyPin.id + '"]');
      } else {
        _readerSpyPin = null;
      }
      if (!active) {
        var h = scroller.clientHeight;
        var base = Math.max(80, h * 0.25);
        var max = scroller.scrollHeight - h;
        var zone = Math.min(h * 0.75, max);
        var left = max - scroller.scrollTop;
        var line = base + (zone > 0 && left < zone ? (h - base) * (1 - Math.max(0, left) / zone) : 0);
        var top = scroller.getBoundingClientRect().top + line;
        Array.prototype.forEach.call(links, function(a) {
          var t = document.getElementById(a.getAttribute('data-target'));
          if (t && t.getBoundingClientRect().top <= top) active = a;
        });
      }
      if (!active && links.length) active = links[0];
      Array.prototype.forEach.call(links, function(a) {
        var on = a === active;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
    }

    /**
     * The newer and older summaries under the rail's current filter (its
     * query and chip, the domain filter, the shelf's own rule), in the rail's
     * order — without the rail's 14-day window, so an older summary has
     * neighbours too. The open summary is always in the list, so the Unread
     * chip still has a place to step from once it is read.
     */
    function readerRefreshNav() {
      var cur = _readerDoc;
      if (!cur || typeof railKey !== 'function') return;
      getSummaryDocuments().then(function(docs) {
        if (_readerDoc !== cur || cur.requestId !== _docRequestId) return;
        var nav = document.getElementById('sumArticleNav');
        if (!nav) return;
        var curKey = railKey({ source: cur.source, id: cur.docId });
        var shelf = (docs || []).filter(function(d) {
          if (typeof isShelfDoc === 'function' && !isShelfDoc(d)) return false;
          if (railKey(d) === curKey) return true;
          if (typeof railHidesDeleted === 'function' && railHidesDeleted(d)) return false;
          return matchesDomain(d);
        });
        var q = typeof _railQuery === 'string' ? _railQuery : '';
        var chip = typeof _railChip === 'string' ? _railChip : 'all';
        var state = typeof railReadState === 'function' ? railReadState() : null;
        var kept = {};
        railFilter(shelf, q, chip, state).forEach(function(d) { kept[railKey(d)] = true; });
        var list = shelf.filter(function(d) { return kept[railKey(d)] || railKey(d) === curKey; }).sort(railCompare);
        var n = readerNeighbours(list.map(railKey), curKey);
        var cell = function(d, cls, label) {
          var t = docTitle(d.id);
          var href = '/summaries?doc=' + encodeURIComponent(d.id) + '&source=' + encodeURIComponent(d.source);
          return '<a class="sum-nav-link ' + cls + '" href="' + esc(href) + '" data-doc-id="' + esc(d.id) + '"' +
            ' data-doc-url="' + esc(d.url || '') + '" data-source="' + esc(d.source) + '" title="' + esc(t) + '">' +
            '<span class="sum-nav-k">' + label + '</span><span class="sum-nav-t">' + esc(t) + '</span></a>';
        };
        var html = (n.newer >= 0 ? cell(list[n.newer], 'sum-nav-newer', '&larr; Newer') : '') +
          (n.older >= 0 ? cell(list[n.older], 'sum-nav-older', 'Older &rarr;') : '');
        nav.innerHTML = html;
        nav.hidden = !html;
        var row = (docs || []).find(function(d) { return railKey(d) === curKey; });
        var main = document.getElementById('sumArticleMain');
        var heroEl = function() {
          var hero = document.getElementById('sumHero');
          if (!hero && main) {
            hero = document.createElement('div');
            hero.className = 'sum-hero';
            hero.id = 'sumHero';
            main.insertBefore(hero, main.firstChild);
          }
          return hero;
        };
        // A Vimeo row the metadata carried no poster for: the listing's.
        if (!cur.hasThumb && cur.source === 'vimeo') {
          var src = row ? readerThumbnail('vimeo', cur.url, row.thumbnail_url) : null;
          if (src && main) {
            heroEl().insertAdjacentHTML('afterbegin', readerThumbHtml(src, 'sum-hero-thumb'));
            cur.hasThumb = true;
          }
        }
        // A document whose metadata carried no date: the listing row's.
        if (cur.pillInput && !readerDay(cur.pillInput.date) && row && readerDay(row.date) && main) {
          cur.pillInput.date = row.date;
          var hero = heroEl();
          var old = hero.querySelector('.sum-pills');
          var html = readerPillsHtml(readerPills(cur.pillInput));
          if (old) old.outerHTML = html; else hero.insertAdjacentHTML('beforeend', html);
        }
      }).catch(function() {});
    }

    // --- Similar cards ---
    /** One card per result, the whole card one link (to the result's
     *  /summaries deep link, opened in place by the panel's click handler):
     *  thumbnail, title, relevance bar, age (amber past READER_STALE_DAYS)
     *  and the why line, each only when the result carries it. */
    function readerSimilarHtml(results, source) {
      var today = readerToday();
      return results.map(function(r) {
        var pct = Math.max(0, Math.min(100, Math.round((r.relevance || 0) * 100)));
        var rTitle = (r.title || r.id || '').replace(/\\.md$/, '');
        var rUrl = r.url || '#';
        var meta = r.metadata || {};
        var thumb = readerThumbnail(source, r.url, meta.thumbnail_url);
        var days = readerDaysBetween(meta.date, today);
        var age = readerAge(meta.date, today);
        var why = readerSimilarWhy(r.matchedChunks);
        var href = '/summaries?doc=' + encodeURIComponent(r.id) + '&source=' + encodeURIComponent(source);
        return '<a class="doc-similar-item sum-sim-card" href="' + esc(href) + '" data-doc-id="' + esc(r.id) + '" data-doc-url="' + esc(rUrl) + '">' +
          readerThumbHtml(thumb, 'sum-sim-thumb') +
          '<span class="sum-sim-main">' +
            '<span class="sum-sim-title">' + esc(rTitle) + '</span>' +
            '<span class="sum-sim-meta">' +
              '<span class="sum-sim-bar" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' +
              '<span class="doc-similar-relevance">' + pct + '%</span>' +
              (age ? '<span class="sum-sim-age' + (days > READER_STALE_DAYS ? ' stale' : '') + '">' + esc(age) + '</span>' : '') +
            '</span>' +
            (why ? '<span class="sum-sim-why" title="' + esc(why.heading) + '"' + (why.transcript ? ' data-transcript="1"' : '') + '>' +
              (why.transcript
                ? '<span class="sum-sim-tag">transcript</span>' + (/^transcript$/i.test(why.heading) ? '' : esc(why.heading))
                : 'Matched: ' + esc(why.heading)) + '</span>' : '') +
          '</span>' +
        '</a>';
      }).join('');
    }
  `;
}
