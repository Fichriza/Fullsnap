// Shared settings with defaults, persisted in chrome.storage.sync.

export const DEFAULTS = {
  format: 'png',            // 'png' | 'jpeg'
  output: 'image',          // 'image' | 'pdf' (quick option in popup; preview pre-opens PDF panel)
  jpegQuality: 90,          // 60..100
  scrollDelay: 300,         // ms pause per scroll step (lazy-load settle time)
  maxHeight: 30000,         // CSS px cap for infinite-scroll pages
  hideSticky: true,
  pdfPaper: 'fit',          // 'fit' | 'a4' | 'letter'
  pdfOrientation: 'portrait',
  pdfMargin: 'none',        // 'none' | 'small' | 'normal'
  pdfMetadata: true,
  filenamePattern: '{title}_{date}_{time}',
  theme: 'auto',            // 'auto' | 'light' | 'dark'
  ocrLang: 'eng+ind',       // 'eng' | 'ind' | 'eng+ind'
  mapGrid: 1                // 1..4 — map mode captures an N×N grid of screens
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: merged });
  return merged;
}
