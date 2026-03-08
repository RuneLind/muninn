const DEFAULTS = {
  javrvisUrl: 'http://localhost:3010',
  userId: '',
};

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById('javrvisUrl').value = settings.javrvisUrl;
  document.getElementById('userId').value = settings.userId;

  document.getElementById('save').addEventListener('click', async () => {
    await chrome.storage.sync.set({
      javrvisUrl: document.getElementById('javrvisUrl').value.trim(),
      userId: document.getElementById('userId').value.trim(),
    });
    const saved = document.getElementById('saved');
    saved.classList.add('show');
    setTimeout(() => saved.classList.remove('show'), 2000);
  });
});
