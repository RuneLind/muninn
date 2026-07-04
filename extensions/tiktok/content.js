/**
 * Content script for TikTok pages.
 * Detects video pages and sends video info to the background worker.
 * Download / transcription / frame extraction is done server-side.
 */

let currentVideoId = null;

// TikTok is a client-side-routed SPA but emits no navigation event we can hook
// (unlike YouTube's `yt-navigate-finish`). Poll the URL for changes instead.
let lastHref = window.location.href;
setInterval(() => {
  if (window.location.href !== lastHref) {
    lastHref = window.location.href;
    checkVideoPage();
  }
}, 700);

// Also catch back/forward navigation.
window.addEventListener('popstate', checkVideoPage);

// Initial load.
checkVideoPage();

function checkVideoPage() {
  const videoId = getVideoId();
  if (videoId && videoId !== currentVideoId) {
    currentVideoId = videoId;
    notifyVideoPage(videoId);
  } else if (!videoId) {
    currentVideoId = null;
  }
}

function getVideoId() {
  // Video pages look like /@username/video/1234567890123456789
  const match = window.location.pathname.match(/\/video\/(\d+)/);
  return match ? match[1] : null;
}

function getVideoUrl() {
  // Canonical URL: strip query/hash, keep the /@user/video/<id> path.
  return `${window.location.origin}${window.location.pathname}`;
}

function notifyVideoPage(videoId) {
  chrome.runtime.sendMessage({
    type: 'VIDEO_PAGE',
    videoId,
    url: getVideoUrl(),
    title: getVideoTitle(),
  });
}

function getVideoTitle() {
  // Try multiple selectors — TikTok's caption markup varies by view (feed vs.
  // detail page) and the SPA may not have rendered it yet.
  const selectors = [
    '[data-e2e="browse-video-desc"]',
    '[data-e2e="video-desc"]',
    'h1[data-e2e="browse-video-desc"]',
    'meta[property="og:description"]',
    'meta[property="og:title"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = sel.startsWith('meta') ? el.getAttribute('content') : el.textContent;
    if (text && text.trim() && text.trim().toLowerCase() !== 'tiktok') {
      return text.trim();
    }
  }
  // Fallback: strip " | TikTok" suffix from document.title.
  const fallback = document.title.replace(/\s*\|\s*TikTok$/, '').trim();
  return fallback || document.title;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VIDEO_INFO') {
    sendResponse({
      videoId: getVideoId(),
      url: getVideoUrl(),
      title: getVideoTitle(),
    });
  }
});
