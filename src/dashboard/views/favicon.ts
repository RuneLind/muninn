// Brand favicon — a stylized white "M" (matching the header's `<span>M</span>uninn`
// mark) on a brand-purple (#6c63ff) rounded square. An SVG so it stays crisp at any
// size and theme. Served at /favicon.svg and /favicon.ico (see routes.ts); browsers
// auto-fetch /favicon.ico on every page, so all pages get the icon with no per-page
// markup, while the two app shells (dashboard + chat) also declare it explicitly.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#6c63ff"/>
  <path d="M8 23 V9 L16 18 L24 9 V23" fill="none" stroke="#fff"
    stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;

// Long-cache: the icon is content-stable, so a year TTL is safe (a change ships a new
// build anyway). `immutable` stops revalidation churn on every navigation.
export const FAVICON_HEADERS = {
  "Content-Type": "image/svg+xml",
  "Cache-Control": "public, max-age=31536000, immutable",
} as const;
