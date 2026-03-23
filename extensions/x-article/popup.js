const $ = (sel) => document.querySelector(sel);

let articleInfo = null;

document.addEventListener('DOMContentLoaded', async () => {
  fetchFreshInfo();

  $('#btn-summarize').addEventListener('click', handleSummarize);
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

function fetchFreshInfo() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.url) {
      showNotArticle();
      return;
    }

    // Check if URL matches article pattern
    const isArticleUrl = /x\.com\/[^/]+\/article\/\d+/.test(tab.url) ||
                         /twitter\.com\/[^/]+\/article\/\d+/.test(tab.url);
    if (!isArticleUrl) {
      showNotArticle();
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'GET_ARTICLE_INFO' }, (info) => {
      if (chrome.runtime.lastError || !info || info.error) {
        showNotArticle();
        return;
      }
      articleInfo = info;
      showArticlePage(info);
    });
  });
}

function showNotArticle() {
  $('#not-article').classList.remove('hidden');
  $('#article-info').classList.add('hidden');
}

function deriveTitle(info) {
  // If title looks like notification junk, try first line of article text
  const title = (info.title || '').trim();
  if (title && title.length > 5 && !/^\(\d+\)/.test(title) && title !== 'X') {
    return title;
  }
  // Extract first substantial line from article text as title
  if (info.articleText) {
    const lines = info.articleText.split('\n').map(l => l.trim()).filter(l => l.length > 10);
    if (lines[0]) return lines[0].slice(0, 200);
  }
  return title || 'Untitled article';
}

function showArticlePage(info) {
  $('#not-article').classList.add('hidden');
  $('#article-info').classList.remove('hidden');
  const title = deriveTitle(info);
  info.title = title; // update for summarize payload
  $('#article-title').textContent = title;
  $('#article-author').textContent = info.author ? `@${info.author}` : '';

  const contentStatus = $('#content-status');
  if (info.hasContent) {
    const charCount = info.articleText.length;
    contentStatus.className = 'ok';
    contentStatus.textContent = `Article content extracted (${Math.round(charCount / 1000)}k chars)`;
    $('#btn-summarize').disabled = false;
  } else {
    contentStatus.className = 'warn';
    contentStatus.textContent = 'Could not extract article content. Try scrolling to load the full article.';
    $('#btn-summarize').disabled = true;
  }
}

async function handleSummarize() {
  const btn = $('#btn-summarize');
  const status = $('#status');

  btn.disabled = true;
  status.className = '';
  status.innerHTML = '<span class="spinner"></span>Submitting to dashboard...';
  status.classList.remove('hidden');

  try {
    // Re-fetch fresh article info from the content script
    const freshInfo = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return resolve(null);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_ARTICLE_INFO' }, resolve);
      });
    });
    if (freshInfo && freshInfo.articleId) {
      articleInfo = freshInfo;
    }

    if (!articleInfo?.articleText || articleInfo.articleText.length < 100) {
      throw new Error('Could not extract article content. Try scrolling to load the full article, then try again.');
    }

    // Submit to Muninn — opens dashboard in new tab
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'SUMMARIZE',
        title: articleInfo.title,
        url: articleInfo.url,
        articleId: articleInfo.articleId,
        author: articleInfo.author,
        articleText: articleInfo.articleText,
      }, (response) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });

    // Close popup — dashboard tab is now open
    window.close();
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
    btn.disabled = false;
  }
}
