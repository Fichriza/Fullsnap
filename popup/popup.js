import { getSettings, saveSettings } from '../src/lib/settings.js';
import { applyI18n, applyTheme, t } from '../src/lib/util.js';

const RESTRICTED_PREFIXES = [
  'chrome://', 'chrome-extension://', 'chrome-search://', 'chrome-untrusted://',
  'edge://', 'about:', 'devtools://', 'view-source:',
  'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'
];

const notice = document.getElementById('notice');
const btnAssets = document.getElementById('btnAssets');
const buttons = {
  full: document.getElementById('btnFull'),
  visible: document.getElementById('btnVisible'),
  selection: document.getElementById('btnSelect'),
  map: document.getElementById('btnMap')
};

function showNotice(key) {
  notice.textContent = t(key);
  notice.hidden = false;
}

function setButtonsEnabled(enabled) {
  for (const btn of Object.values(buttons)) btn.disabled = !enabled;
}

async function init() {
  applyI18n();
  applyTheme();

  const settings = await getSettings();
  document.querySelector(`input[name="format"][value="${settings.format}"]`).checked = true;
  document.querySelector(`input[name="output"][value="${settings.output}"]`).checked = true;

  for (const input of document.querySelectorAll('input[name="format"], input[name="output"]')) {
    input.addEventListener('change', () => {
      saveSettings({ [input.name]: input.value });
    });
  }

  document.getElementById('btnSettings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  const commands = await chrome.commands.getAll();
  const captureCmd = commands.find((c) => c.name === 'capture-full-page');
  if (captureCmd && captureCmd.shortcut) {
    document.getElementById('shortcutHint').textContent = `⌨ ${captureCmd.shortcut}`;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';
  if (RESTRICTED_PREFIXES.some((p) => url.startsWith(p))) {
    setButtonsEnabled(false);
    showNotice('restrictedPage');
    return;
  }

  const mapGridRow = document.getElementById('mapGridRow');

  // Show/hide grid picker when Map button is focused/used
  buttons.map.addEventListener('mouseenter', () => { mapGridRow.hidden = false; });
  document.addEventListener('mouseleave', (e) => {
    if (!e.relatedTarget) mapGridRow.hidden = true;
  });

  for (const [mode, btn] of Object.entries(buttons)) {
    btn.addEventListener('click', async () => {
      setButtonsEnabled(false);
      const extra = {};
      if (mode === 'map') {
        const gridInput = document.querySelector('input[name="mapgrid"]:checked');
        extra.grid = gridInput ? parseInt(gridInput.value, 10) : 1;
      }
      const res = await chrome.runtime.sendMessage({ type: 'CAPTURE', mode, ...extra });
      if (res && res.ok) {
        window.close();
      } else {
        setButtonsEnabled(true);
        showNotice((res && res.error) || 'captureFailed');
      }
    });
  }

  // Show grid row when any map grid radio changes
  for (const input of document.querySelectorAll('input[name="mapgrid"]')) {
    input.addEventListener('change', () => { mapGridRow.hidden = false; });
  }

  btnAssets.addEventListener('click', async () => {
    setButtonsEnabled(false);
    btnAssets.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_ASSETS' });
    setButtonsEnabled(true);
    btnAssets.disabled = false;
    if (res && res.ok) {
      if (res.count === 0) {
        showNotice('assetsNone');
      } else {
        showNotice(chrome.i18n.getMessage('assetsQueued', [String(res.count)]));
        setTimeout(() => window.close(), 1200);
      }
    } else {
      showNotice((res && res.error) || 'captureFailed');
    }
  });
}

init();
