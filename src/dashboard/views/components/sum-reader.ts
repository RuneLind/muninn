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
 * renderMarkdown, splitTranscript, linkVimeoTimestamps, getSummaryDocuments,
 * matchesDomain, docTitle, SOURCES, esc, _docRequestId, _shareDoc), sum-shelf.ts
 * (isShelfDoc) and sum-latest-rail.ts (railKey, railCompare, railFilter,
 * railReadState, railHidesDeleted, _railQuery, _railChip); every read of the
 * rail's state is guarded, so the article renders without it.
 */

import { READER_FUNCTIONS } from "../../../summaries/reader-article.ts";
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

/** A Similar card's age turns amber past this many days. */
export const SIMILAR_STALE_DAYS = 60;

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
    /* Similar cards. */
    .doc-similar-item.sum-sim-card { display: flex; gap: 10px; padding: 8px 0; }
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
    .sum-sim-why { font-size: 11px; color: var(--text-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
${READER_FUNCTIONS.map((fn) => `    var ${fn.name} = ${fn.toString()};`).join("\n")}
    // --- reader-fns:end ---

    function readerToday() { return new Date().toISOString().slice(0, 10); }

    // --- ⋯ More (docPanelHtml({moreMenu:true})) ---
    function moreMenuEl() { return document.getElementById('${DOC_PANEL_MORE_MENU_ID}'); }
    function moreBtnEl() { return document.getElementById('${DOC_PANEL_MORE_BTN_ID}'); }
    function moreMenuOpen() { var p = moreMenuEl(); return !!p && !p.hidden; }
    /** Closes the menu; \`restoreFocus\` puts focus back on ⋯ More (Escape, an
     *  item used), and is false for a click elsewhere, which keeps its own. */
    function closeMoreMenu(restoreFocus) {
      var pop = moreMenuEl();
      if (!pop || pop.hidden) return;
      pop.hidden = true;
      var btn = moreBtnEl();
      if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        if (restoreFocus) btn.focus();
      }
    }
    function moreMenuItems() {
      var pop = moreMenuEl();
      if (!pop) return [];
      return Array.prototype.filter.call(pop.querySelectorAll('.doc-panel-menu-item'), function(el) {
        return !el.hidden && !el.disabled;
      });
    }
    function focusMoreItem(delta) {
      var items = moreMenuItems();
      if (!items.length) return;
      var at = items.indexOf(document.activeElement);
      items[at === -1 ? 0 : (at + delta + items.length) % items.length].focus();
    }
    function openMoreMenu() {
      var pop = moreMenuEl();
      if (!pop) return;
      if (typeof closeRerunMenu === 'function' && typeof rerunMenuOpen === 'function' && rerunMenuOpen()) closeRerunMenu();
      var copy = document.getElementById('${DOC_PANEL_COPY_LINK_ID}');
      if (copy) copy.textContent = '🔗 Copy link';
      pop.hidden = false;
      readerKeepInViewport(pop);
      var btn = moreBtnEl();
      if (btn) btn.setAttribute('aria-expanded', 'true');
      focusMoreItem(0);
    }

    /** The popup hangs from its button's right edge; on a narrow screen the
     *  wrapped header can put that edge anywhere, so shift it back inside. */
    function readerKeepInViewport(pop) {
      pop.style.transform = '';
      var r = pop.getBoundingClientRect();
      var margin = 8;
      var dx = 0;
      if (r.left < margin) dx = margin - r.left;
      else if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
      if (dx) pop.style.transform = 'translateX(' + Math.round(dx) + 'px)';
    }

    /** The /summaries deep link to the open summary — the shape the page's
     *  init reads (doc + source). */
    function readerDocLink() {
      if (!_shareDoc) return '';
      return location.origin + '/summaries?doc=' + encodeURIComponent(_shareDoc.docId) +
        '&source=' + encodeURIComponent(_shareDoc.source);
    }

    function readerCopyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(function() { return true; }, function() { return readerCopyFallback(text); });
      }
      return Promise.resolve(readerCopyFallback(text));
    }
    /** An http:// page off loopback has no navigator.clipboard (not a secure
     *  context), which is how the mini is reached over the tailnet. */
    function readerCopyFallback(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }

    (function() {
      var btn = moreBtnEl();
      var pop = moreMenuEl();
      if (!btn || !pop) return;
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (moreMenuOpen()) closeMoreMenu(true); else openMoreMenu();
      });
      document.addEventListener('click', function(e) {
        if (!moreMenuOpen()) return;
        if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMoreMenu(false);
      });
      pop.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); focusMoreItem(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusMoreItem(-1); }
        else if (e.key === 'Home') { e.preventDefault(); var a = moreMenuItems(); if (a.length) a[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); var b = moreMenuItems(); if (b.length) b[b.length - 1].focus(); }
        else if (e.key === 'Tab') closeMoreMenu(false);
      });
      // Export downloads and Delete asks first; either way the menu has done
      // its job. Copy link stays open to say it copied.
      var exp = document.getElementById('${DOC_PANEL_EXPORT_LINK_ID}');
      if (exp) exp.addEventListener('click', function() { closeMoreMenu(true); });
      var del = document.getElementById('${DOC_PANEL_DELETE_BTN_ID}');
      if (del) del.addEventListener('click', function() { closeMoreMenu(true); });
      var copy = document.getElementById('${DOC_PANEL_COPY_LINK_ID}');
      if (copy) copy.addEventListener('click', function() {
        var link = readerDocLink();
        if (!link) return;
        readerCopyText(link).then(function(ok) {
          if (ok) { copy.textContent = '✓ Link copied'; return; }
          // Neither path could write the clipboard: hand the link over to copy by hand.
          window.prompt('Copy this link', link);
        });
      });
    })();

    // --- The article column ---
    var _readerDoc = null;     // {docId, source, requestId, url, thumb} of the open article
    var _readerSpyWired = false;
    var _readerSpyFrame = 0;

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

    function readerThumbHtml(src) {
      // A video YouTube no longer serves answers 404: the image goes rather
      // than leaving a broken-image box.
      return src ? '<img class="sum-hero-thumb" src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '';
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
      var pills = readerPills({
        sourceLabel: src ? src.badge : null,
        date: meta.date,
        today: readerToday(),
        kind: meta.summary_kind,
        category: meta.category,
        author: meta.author,
        uploadDate: meta.upload_date,
        durationSec: meta.duration_sec,
        body: raw.body,
        transcript: raw.transcript,
      });
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
        ? '<div class="sum-hero" id="sumHero">' + readerThumbHtml(thumb) + readerPillsHtml(pills) + '</div>'
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
      var prefix = 'https://www.youtube.com/watch?v=' + id + '&t=';
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
      _readerDoc = { docId: ctx.docId, source: ctx.source, requestId: ctx.requestId, url: ctx.videoUrl, hasThumb: !!mainEl.querySelector('.sum-hero-thumb') };
      readerTimestampLinksInNewTab(mainEl, ctx.source, ctx.videoUrl);
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
          openSummaryDoc(nl.getAttribute('data-doc-id'), nl.getAttribute('data-doc-url'), nl.getAttribute('data-source'));
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
        readerSpy();
      });
    }

    /** Marks the outline entry of the section the reader is in: the last
     *  target whose top has passed the top of the panel body. */
    function readerSpy() {
      var nav = document.getElementById('sumOutline');
      var scroller = document.getElementById('docPanelBody');
      if (!nav || nav.hidden || !scroller) return;
      var links = nav.querySelectorAll('a.sum-outline-link');
      // A section is "in view" once its heading passes the top quarter.
      var top = scroller.getBoundingClientRect().top + Math.max(80, scroller.clientHeight * 0.25);
      var active = null;
      Array.prototype.forEach.call(links, function(a) {
        var t = document.getElementById(a.getAttribute('data-target'));
        if (t && t.getBoundingClientRect().top <= top) active = a;
      });
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
        // A Vimeo row the metadata carried no poster for: the listing's.
        if (!cur.hasThumb && cur.source === 'vimeo') {
          var row = (docs || []).find(function(d) { return railKey(d) === curKey; });
          var src = row ? readerThumbnail('vimeo', cur.url, row.thumbnail_url) : null;
          var hero = document.getElementById('sumHero');
          var main = document.getElementById('sumArticleMain');
          if (src && main) {
            if (!hero) {
              hero = document.createElement('div');
              hero.className = 'sum-hero';
              hero.id = 'sumHero';
              main.insertBefore(hero, main.firstChild);
            }
            hero.insertAdjacentHTML('afterbegin', readerThumbHtml(src));
            cur.hasThumb = true;
          }
        }
      }).catch(function() {});
    }

    // --- Similar cards ---
    /** One card per result: thumbnail, title, relevance bar, age (amber past
     *  ${SIMILAR_STALE_DAYS} days) and the why line, each only when the
     *  result carries it. */
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
        return '<div class="doc-similar-item sum-sim-card" data-doc-id="' + esc(r.id) + '" data-doc-url="' + esc(rUrl) + '">' +
          (thumb ? '<img class="sum-sim-thumb" src="' + esc(thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
          '<div class="sum-sim-main">' +
            '<a href="#">' + esc(rTitle) + '</a>' +
            '<div class="sum-sim-meta">' +
              '<span class="sum-sim-bar" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' +
              '<span class="doc-similar-relevance">' + pct + '%</span>' +
              (age ? '<span class="sum-sim-age' + (days > ${SIMILAR_STALE_DAYS} ? ' stale' : '') + '">' + esc(age) + '</span>' : '') +
            '</div>' +
            (why ? '<div class="sum-sim-why" title="' + esc(why.heading) + '"' + (why.transcript ? ' data-transcript="1"' : '') + '>' +
              (why.transcript
                ? '<span class="sum-sim-tag">transcript</span>' + (/^transcript$/i.test(why.heading) ? '' : esc(why.heading))
                : 'Matched: ' + esc(why.heading)) + '</div>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }
  `;
}
