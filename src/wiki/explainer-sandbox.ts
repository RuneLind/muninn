/**
 * The sandbox a served explainer runs under, spelled ONCE — the `sandbox`
 * attribute on both reader iframes AND the route's CSP `sandbox` directive
 * (what covers the <Embed> "open in new tab" top-level load, where an
 * attribute cannot reach). No `allow-same-origin`, ever: the document must
 * stay opaque-origin so a wiki-hosted script cannot reach /api/* with the
 * reader's session. `allow-downloads` is load-bearing — an archify viewer's
 * Export menu silently did nothing without it (measured: no download, no
 * error, and its `alert()` failure path is sandboxed too).
 *
 * Its own dependency-free module, NOT a sibling of `EXPLAINER_BRIDGE_SCRIPT`:
 * that string contains a literal `<\/script>` (written escaped even here, since
 * this docblock rides the same bundle), and the wiki reader is an
 * inlined browser bundle — importing the bridge module into it closed the
 * page's own script tag mid-bundle and blanked the reader (measured: every
 * wiki e2e spec red, "Unexpected end of input").
 */
export const EXPLAINER_SANDBOX = "allow-scripts allow-popups allow-downloads";
