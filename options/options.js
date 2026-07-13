import { getSettings, saveSettings } from '../src/lib/settings.js';
import { applyI18n, applyTheme, t } from '../src/lib/util.js';

const FIELDS = [
  ['scrollDelay', 'number'],
  ['maxHeight', 'number'],
  ['hideSticky', 'checkbox'],
  ['format', 'value'],
  ['jpegQuality', 'number'],
  ['filenamePattern', 'value'],
  ['ocrLang', 'value'],
  ['pdfPaper', 'value'],
  ['pdfOrientation', 'value'],
  ['pdfMargin', 'value'],
  ['pdfMetadata', 'checkbox'],
  ['theme', 'value']
];

const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1500);
}

function readField(el, kind) {
  if (kind === 'checkbox') return el.checked;
  if (kind === 'number') return Number(el.value);
  return el.value;
}

function writeField(el, kind, value) {
  if (kind === 'checkbox') el.checked = value;
  else el.value = value;
}

async function init() {
  applyI18n();
  applyTheme();
  document.title = t('optionsTitle');

  const settings = await getSettings();
  const qualityVal = document.getElementById('jpegQualityVal');

  for (const [id, kind] of FIELDS) {
    const el = document.getElementById(id);
    writeField(el, kind, settings[id]);
    el.addEventListener('change', async () => {
      await saveSettings({ [id]: readField(el, kind) });
      if (id === 'theme') applyTheme();
      toast(t('saved'));
    });
  }

  qualityVal.textContent = settings.jpegQuality;
  document.getElementById('jpegQuality').addEventListener('input', (e) => {
    qualityVal.textContent = e.target.value;
  });

  document.getElementById('btnShortcut').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

init();
