/**
 * Content script for X/Twitter article pages.
 * Detects article pages and extracts article content from the rendered DOM.
 * X articles are client-side rendered, so we wait for content to appear.
 */

let currentArticleId = null;

// Detect navigation to article pages (X is a SPA).
// Debounced — X fires hundreds of mutations per second.
let debounceTimer = null;
const observer = new MutationObserver(() => {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const info = parseArticleUrl();
    if (info && info.articleId !== currentArticleId) {
      currentArticleId = info.articleId;
      notifyArticlePage(info);
    } else if (!info) {
      currentArticleId = null;
    }
  }, 300);
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial check
const initial = parseArticleUrl();
if (initial) {
  currentArticleId = initial.articleId;
  notifyArticlePage(initial);
}

function parseArticleUrl() {
  const match = window.location.pathname.match(/^\/([^/]+)\/article\/([0-9]+)/);
  if (!match) return null;
  return {
    author: match[1],
    articleId: match[2],
    url: window.location.href.split('?')[0],
  };
}

function notifyArticlePage(info) {
  chrome.runtime.sendMessage({
    type: 'ARTICLE_PAGE',
    ...info,
    title: getArticleTitle(),
  });
}

/**
 * Clean notification counts and platform suffix from page title.
 * X titles look like: "(1) Why we banned React's useEffect / X"
 */
function cleanPageTitle() {
  return document.title
    .replace(/^\(\d+\)\s*/, '')       // strip "(1) " notification prefix
    .replace(/\s*\/\s*X\s*$/, '')     // strip " / X" suffix
    .replace(/\s*[|]\s*X\s*$/, '')    // strip " | X" suffix
    .replace(/\s*\/\s*Twitter\s*$/, '') // strip " / Twitter"
    .trim();
}

function getArticleTitle() {
  // Scope search to main content area — skip dialogs, tooltips, overlays
  const main = document.querySelector('[data-testid="primaryColumn"]')
    || document.querySelector('main[role="main"]')
    || document.querySelector('main');

  if (main) {
    // Collect all heading candidates with their font size, pick the largest.
    // X renders the article title as a styled element (not semantic h1),
    // so font size is the most reliable signal — the title is the biggest text.
    const candidates = [];

    // First pass: semantic headings (cheap — few elements)
    for (const el of main.querySelectorAll('h1, h2, h3, [role="heading"]')) {
      if (el.closest('[role="dialog"], [aria-modal], [role="alertdialog"]')) continue;
      const text = (el.innerText || '').trim();
      if (!isGoodTitle(text)) continue;
      const style = window.getComputedStyle(el);
      const fontSize = parseFloat(style.fontSize) || 0;
      const fontWeight = parseInt(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
      if (fontWeight >= 600) {
        candidates.push({ text, fontSize });
      }
    }

    // Second pass only if no semantic headings found: check styled elements,
    // but limit to first few levels to avoid scanning thousands of nodes
    if (candidates.length === 0) {
      for (const el of main.querySelectorAll(':scope > div span, :scope > div > div span')) {
        if (el.closest('[role="dialog"], [aria-modal], [role="alertdialog"]')) continue;
        const text = (el.innerText || '').trim();
        if (!isGoodTitle(text)) continue;
        const style = window.getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize) || 0;
        const fontWeight = parseInt(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
        if (fontSize >= 24 && fontWeight >= 600) {
          candidates.push({ text, fontSize });
        }
      }
    }

    // Return the candidate with the largest font size
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.fontSize - a.fontSize);
      return candidates[0].text;
    }
  }

  // Fall back to cleaned page title
  const cleaned = cleanPageTitle();
  if (cleaned && cleaned.length > 5) return cleaned;

  return document.title;
}

function isGoodTitle(text) {
  if (!text || text.length < 5 || text.length > 300) return false;
  if (/^\(\d+\)/.test(text)) return false;
  if (text === 'X' || text === 'Twitter') return false;
  // Skip UI strings
  if (/keyboard shortcut/i.test(text)) return false;
  if (/^(Follow|Sign up|Log in|Explore|Settings|Home)\b/i.test(text)) return false;
  return true;
}

/**
 * Extract the article's full text content from the rendered DOM.
 * Uses innerText for accurate visible-text extraction, then applies
 * multiple strategies to find the right container.
 */
function extractArticleText() {
  // Cache the main content element across strategies
  const main = document.querySelector('[data-testid="primaryColumn"]')
    || document.querySelector('main[role="main"]')
    || document.querySelector('main');

  const strategies = [
    () => {
      if (!main) return null;
      return extractCleanText(main);
    },
    () => {
      const articles = document.querySelectorAll('article');
      let best = '';
      for (const article of articles) {
        const text = extractCleanText(article);
        if (text.length > best.length) best = text;
      }
      return best || null;
    },
    () => {
      const selectors = [
        '[data-testid="tweetText"]',
        '[data-testid="article"]',
        '[data-testid="articleContent"]',
        '[data-testid="richTextEditor"]',
      ];
      const texts = [];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.innerText.trim();
          if (t.length > 30) texts.push(t);
        }
      }
      return texts.length > 0 ? texts.join('\n\n') : null;
    },
    () => {
      const blocks = [];
      for (const el of document.querySelectorAll('[dir="ltr"]')) {
        if (el.closest('nav, header, aside, [role="navigation"], [role="banner"]')) continue;
        const t = el.innerText.trim();
        if (t.length > 40) blocks.push(t);
      }
      return blocks.length > 0 ? deduplicateBlocks(blocks).join('\n\n') : null;
    },
    () => {
      if (!main) return null;
      return main.innerText;
    },
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy();
      if (result && result.length > 100) return result;
    } catch {
      // strategy failed, try next
    }
  }

  return null;
}

/**
 * Extract clean text from a container using innerText (respects visibility
 * and CSS), then filter out UI chrome like buttons, timestamps, stats.
 */
function extractCleanText(container) {
  // Use innerText — it respects visibility and gives us what the user sees
  const raw = container.innerText || '';
  const lines = raw.split('\n');

  // Filter out lines that look like UI chrome
  const uiPatterns = [
    /^(Follow|Following|Sign up|Log in|More|Share|Bookmark|Copy link)$/i,
    /^\d+(\.\d+)?[KMB]?\s*(views?|likes?|reposts?|replies|bookmarks?)$/i,  // engagement stats
    /^(Reply|Repost|Like|View|Bookmark)$/i,
    /^@\w+\s*·\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+$/i, // author line
    /^·$/,
    /^\(\d+\)$/, // notification count
  ];

  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.length < 3) return false;
    return !uiPatterns.some(p => p.test(trimmed));
  });

  return filtered.join('\n');
}

/**
 * Remove consecutive duplicate text blocks.
 */
function deduplicateBlocks(blocks) {
  return blocks.filter((block, i) => i === 0 || block !== blocks[i - 1]);
}

// Handle messages from popup/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_ARTICLE_INFO') {
    const info = parseArticleUrl();
    if (!info) {
      sendResponse({ error: 'Not on an X article page' });
      return;
    }

    // Try extraction immediately
    let articleText = extractArticleText();
    let title = getArticleTitle();

    if (articleText && articleText.length > 100) {
      sendResponse({
        ...info,
        title,
        articleText,
        hasContent: true,
      });
      return;
    }

    // Content might still be loading — retry after a short delay
    setTimeout(() => {
      articleText = extractArticleText();
      title = getArticleTitle();
      sendResponse({
        ...info,
        title,
        articleText: articleText || '',
        hasContent: !!articleText && articleText.length > 100,
      });
    }, 1500);

    return true; // keep sendResponse alive for async reply
  }
});
