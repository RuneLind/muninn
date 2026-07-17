/**
 * Select-to-Explain **forwarder** injected into standalone HTML explainer pages
 * served for the /wiki reader's sandboxed `<iframe>`.
 *
 * The explainer iframe is `sandbox="allow-scripts allow-popups"` — deliberately
 * WITHOUT `allow-same-origin`, so it runs on an opaque origin and the parent
 * reader cannot read the iframe's selection directly. This listener-only script
 * bridges that gap with `postMessage`: on a non-collapsed selection it forwards
 * the selected text, the nearest preceding heading, and the selection rect to the
 * parent, which floats the same "✨ Explain" pill it uses for markdown pages.
 *
 * Kept as a plain string constant (not module code) so it is (a) testable as a
 * string and (b) trivially appended to the served HTML by the route — a trailing
 * listener-only script executes wherever it lands, so no anchor parsing is
 * needed. Plain ES5-ish DOM APIs only, no deps, no `console.*`.
 *
 * `targetOrigin: "*"` is unavoidable and acceptable: the opaque-origin frame
 * cannot name the parent origin, and the payload is the reader's own selection on
 * their own loopback dashboard — not a secret. The REAL gate is the parent side,
 * which trusts a message only when `event.source` is the live explainer frame's
 * `contentWindow` (see `wiki-browser.ts`).
 */

/** Distinctive substring present in the injected script — used by the route test
 *  to confirm the bridge was appended to the served explainer HTML. */
export const EXPLAINER_BRIDGE_MARKER = "wiki-explainer-bridge";

/** The `<script>…</script>` forwarder appended to every served explainer page. */
export const EXPLAINER_BRIDGE_SCRIPT = `<script>/* ${EXPLAINER_BRIDGE_MARKER} */
(function () {
  if (window.parent === window) return; // opened from disk / directly — no bridge
  var MIN = 3;
  var last = "";
  function clearSel() {
    if (last !== "") {
      last = "";
      window.parent.postMessage({ type: "wiki-explain-clear" }, "*");
    }
  }
  function nearestHeading(range) {
    var start = range.startContainer;
    var startEl = start.nodeType === 1 ? start : start.parentElement;
    if (!startEl) return "";
    var HEAD = /^H[1-4]$/;
    var node = startEl;
    while (node && node !== document.body) {
      var sib = node.previousElementSibling;
      while (sib) {
        if (HEAD.test(sib.tagName)) return (sib.textContent || "").trim();
        var inner = sib.querySelectorAll ? sib.querySelectorAll("h1,h2,h3,h4") : null;
        if (inner && inner.length) return (inner[inner.length - 1].textContent || "").trim();
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }
  function post() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return clearSel();
    var text = sel.toString().trim();
    if (text.length < MIN) return clearSel();
    if (text === last) return; // selectionchange fires per caret move — throttle
    last = text;
    var range = sel.getRangeAt(0);
    var r = range.getBoundingClientRect();
    window.parent.postMessage(
      {
        type: "wiki-explain-sel",
        sel: text,
        heading: nearestHeading(range),
        rect: { top: r.top, left: r.left, width: r.width, height: r.height }
      },
      "*"
    );
  }
  document.addEventListener("selectionchange", post);
  document.addEventListener("mouseup", function () { setTimeout(post, 0); });
})();
</script>`;
