/**
 * Content script for YouTube pages.
 * Detects video pages and sends video info to background worker.
 * Transcript fetching is done server-side to avoid adblocker interference.
 */

let currentVideoId = null;

document.addEventListener('yt-navigate-finish', () => {
  const videoId = getVideoId();
  if (videoId && videoId !== currentVideoId) {
    currentVideoId = videoId;
    notifyVideoPage(videoId);
  }
});

if (window.location.pathname === '/watch') {
  const videoId = getVideoId();
  if (videoId) {
    currentVideoId = videoId;
    notifyVideoPage(videoId);
  }
}

function getVideoId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('v');
}

function notifyVideoPage(videoId) {
  chrome.runtime.sendMessage({
    type: 'VIDEO_PAGE',
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: getVideoTitle(),
  });
}

function getVideoTitle() {
  // Try multiple selectors — YouTube SPA may not have rendered the title yet
  const selectors = [
    'h1.ytd-watch-metadata yt-formatted-string',
    'h1.ytd-video-primary-info-renderer',
    '#title h1',
    'meta[property="og:title"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = sel.startsWith('meta') ? el.getAttribute('content') : el.textContent;
    if (text && text.trim() && text.trim().toLowerCase() !== 'youtube') {
      return text.trim();
    }
  }
  // Fallback: strip " - YouTube" suffix from document.title
  const fallback = document.title.replace(/\s*-\s*YouTube$/, '').trim();
  return fallback || document.title;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VIDEO_INFO') {
    sendResponse({
      videoId: getVideoId(),
      url: `https://www.youtube.com/watch?v=${getVideoId()}`,
      title: getVideoTitle(),
    });
  }
});
