// Small shared helpers for extension pages (popup, preview, options).

export function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

// Fill elements carrying data-i18n / data-i18n-title with localized strings.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
}

export function sanitizeFilename(s) {
  const clean = String(s)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return clean || 'capture';
}

export function buildFilename(pattern, title, ext) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}-${p2(d.getMinutes())}`;
  const base = (pattern || '{title}_{date}_{time}')
    .replace('{title}', sanitizeFilename(title))
    .replace('{date}', date)
    .replace('{time}', time);
  return `${sanitizeFilename(base)}.${ext}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function applyTheme() {
  const stored = await chrome.storage.sync.get('settings');
  const theme = (stored.settings && stored.settings.theme) || 'auto';
  document.documentElement.dataset.theme = theme;
}
