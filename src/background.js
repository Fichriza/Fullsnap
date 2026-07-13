// FullSnap service worker: capture orchestration.
// Flow: popup/shortcut -> validate tab -> inject content script -> scroll+capture
// loop -> store slices in IndexedDB -> open the preview tab for stitching/export.

import { getSettings } from './lib/settings.js';
import { saveCapture, cleanupOldCaptures } from './lib/db.js';

const CAPTURE_MIN_INTERVAL = 550; // ms — captureVisibleTab is limited to ~2 calls/sec
const MAX_SLICES = 500;

const state = { busy: false, cancelled: false };

const RESTRICTED_PREFIXES = [
  'chrome://', 'chrome-extension://', 'chrome-search://', 'chrome-untrusted://',
  'edge://', 'about:', 'devtools://', 'view-source:',
  'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'
];

function isRestricted(url) {
  return !url || RESTRICTED_PREFIXES.some((p) => url.startsWith(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// captureVisibleTab never resolves while the window is occluded/minimized;
// fail the capture instead of leaving the busy flag wedged forever.
function captureFrame(windowId) {
  return Promise.race([
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('capture timed out — is the window visible?')), 15000))
  ]);
}

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, { __fullsnap: true, ...msg });
}

async function ensureInjected(tabId) {
  try {
    await send(tabId, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  cleanupOldCaptures().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'CAPTURE') {
    startCapture(msg.mode).then(sendResponse);
    return true;
  }
  if (msg.type === 'DOWNLOAD_ASSETS') {
    downloadAssets().then(sendResponse);
    return true;
  }
  if (msg.type === 'FULLSNAP_CANCEL') {
    state.cancelled = true;
  }
  if (msg.type === 'SELECTION_MADE' && sender.tab) {
    captureSelection(sender.tab, msg).catch((err) => console.error('FullSnap:', err));
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-full-page') startCapture('full');
});

// Validates and kicks off a capture; responds quickly so the popup can close
// or show an error, then continues asynchronously.
async function startCapture(mode) {
  if (state.busy) return { error: 'busy' };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: 'captureFailed' };
  if (isRestricted(tab.url)) return { error: 'restrictedPage' };
  const settings = await getSettings();
  try {
    if (mode === 'visible') {
      runGuarded(() => captureVisible(tab));
      return { ok: true };
    }
    await ensureInjected(tab.id);
    if (mode === 'selection') {
      await send(tab.id, { type: 'START_SELECTION' });
      return { ok: true };
    }
    if (mode === 'map') {
      runGuarded(() => captureMap(tab, msg.grid || 1));
      return { ok: true };
    }
    runGuarded(() => captureFullPage(tab, settings));
    return { ok: true };
  } catch (err) {
    console.error('FullSnap:', err);
    return { error: 'captureFailed' };
  }
}

async function runGuarded(fn) {
  state.busy = true;
  state.cancelled = false;
  try {
    await fn();
  } catch (err) {
    if (!err || !err.cancelled) console.error('FullSnap capture failed:', err);
  } finally {
    state.busy = false;
  }
}

async function captureFullPage(tab, settings) {
  let lastCaptureAt = 0;
  const slices = [];
  try {
    const prep = await send(tab.id, { type: 'PREPARE', hideSticky: settings.hideSticky });
    const rect = prep.rect;
    let y = 0;
    let prevY = -1;
    let lastTotal = Math.min(prep.totalHeight, settings.maxHeight);

    while (true) {
      if (state.cancelled) throw { cancelled: true };
      const step = await send(tab.id, {
        type: 'SCROLL_STEP',
        y,
        first: slices.length === 0,
        delay: settings.scrollDelay,
        hideSticky: settings.hideSticky
      });
      const wait = CAPTURE_MIN_INTERVAL - (Date.now() - lastCaptureAt);
      if (wait > 0) await sleep(wait);
      if (state.cancelled) throw { cancelled: true };
      const dataUrl = await captureFrame(tab.windowId);
      lastCaptureAt = Date.now();
      slices.push({ y: step.y, dataUrl });

      lastTotal = Math.min(step.totalHeight, settings.maxHeight);
      const covered = step.y + rect.h;
      send(tab.id, {
        type: 'PROGRESS',
        percent: Math.min(99, Math.round((covered / lastTotal) * 100))
      }).catch(() => {});

      if (covered >= lastTotal - 1) break;      // reached bottom (or max-height cap)
      if (step.y <= prevY) break;               // no scroll progress — bottom reached early
      if (slices.length >= MAX_SLICES) break;
      prevY = step.y;
      y = step.y + rect.h;
    }

    await send(tab.id, { type: 'CLEANUP' });
    const id = await persistCapture(tab, {
      mode: 'full',
      viewportW: prep.viewportW,
      rect,
      positions: slices.map((s) => s.y),
      heightCss: Math.min(slices[slices.length - 1].y + rect.h, lastTotal)
    }, slices.map((s) => s.dataUrl));
    await openPreview(tab, id);
  } catch (err) {
    try { await send(tab.id, { type: 'CLEANUP' }); } catch {}
    throw err;
  }
}

async function captureVisible(tab) {
  const dataUrl = await captureFrame(tab.windowId);
  const id = await persistCapture(tab, {
    mode: 'visible',
    viewportW: tab.width || null
  }, [dataUrl]);
  await openPreview(tab, id);
}

// Clean map capture: hide the map service's UI chrome (search box, side
// panels, zoom controls — attribution stays), grab one frame, restore.
async function captureMap(tab, grid = 1) {
  await ensureInjected(tab.id);
  const prep = await send(tab.id, { type: 'MAP_PREPARE' });
  try {
    const vw = prep.viewportW || tab.width || window.innerWidth;
    const vh = prep.viewportH || tab.height || window.innerHeight;

    if (grid <= 1) {
      // Single-shot capture (original behaviour)
      const dataUrl = await captureFrame(tab.windowId);
      const id = await persistCapture(tab, {
        mode: 'map', viewportW: vw
      }, [dataUrl]);
      await openPreview(tab, id);
      return;
    }

    // NxN grid: capture tiles row-by-row, left-to-right.
    // After each row we pan back to column 0 and pan down one viewport.
    const dataUrls = [];
    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) {
        if (state.cancelled) throw { cancelled: true };
        await sleep(CAPTURE_MIN_INTERVAL);
        dataUrls.push(await captureFrame(tab.windowId));
        // Pan right one viewport (except after last column)
        if (col < grid - 1) {
          await send(tab.id, { type: 'MAP_PAN', dx: vw, dy: 0 });
        }
      }
      // Pan back to leftmost column and down one viewport (except after last row)
      if (row < grid - 1) {
        await send(tab.id, { type: 'MAP_PAN', dx: -(vw * (grid - 1)), dy: vh });
      }
    }

    const id = await persistCapture(tab, {
      mode: 'map',
      grid,
      gridCols: grid,
      gridRows: grid,
      viewportW: vw,
      viewportH: vh
    }, dataUrls);
    await openPreview(tab, id);
  } finally {
    await send(tab.id, { type: 'MAP_RESTORE' }).catch(() => {});
  }
}

async function captureSelection(tab, msg) {
  if (state.busy) return;
  await runGuarded(async () => {
    const dataUrl = await captureFrame(tab.windowId);
    const id = await persistCapture(tab, {
      mode: 'selection',
      viewportW: msg.viewportW,
      crop: msg.rect
    }, [dataUrl]);
    await openPreview(tab, id);
  });
}

async function persistCapture(tab, extra, dataUrls) {
  const blobs = await Promise.all(dataUrls.map((u) => fetch(u).then((r) => r.blob())));
  const meta = {
    id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    title: tab.title || 'capture',
    url: tab.url || '',
    sliceCount: blobs.length,
    ...extra
  };
  await saveCapture(meta, blobs);
  cleanupOldCaptures().catch(() => {});
  return meta.id;
}

async function openPreview(tab, id) {
  await chrome.tabs.create({
    url: chrome.runtime.getURL('preview/preview.html') + '?id=' + id,
    index: tab.index + 1
  });
}

// Convert ArrayBuffer to base64 in chunks to avoid call stack overflow on large files
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function downloadAssets() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: 'captureFailed' };
  if (isRestricted(tab.url)) return { error: 'restrictedPage' };
  try {
    await ensureInjected(tab.id);
    const res = await send(tab.id, { type: 'GET_ASSETS' });
    const urls = res && res.urls ? res.urls : [];
    let html = res && res.html ? res.html : '';
    if (!html) return { count: 0 };

    // Fetch each asset and convert to data URL
    const dataUrlMap = new Map();
    await Promise.all(urls.map(async (url) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const buf = await resp.arrayBuffer();
        const mime = (resp.headers.get('content-type') || 'application/octet-stream').split(';')[0];
        dataUrlMap.set(url, `data:${mime};base64,${bufToBase64(buf)}`);
      } catch {}
    }));

    // Inject <base> tag so remaining relative URLs still resolve
    html = html.replace(/<head([^>]*)>/i, (m, attrs) =>
      `<head${attrs}><base href="${res.baseUrl}">`
    );

    // Replace every fetched asset URL with its data URL
    for (const [url, dataUrl] of dataUrlMap) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(escaped, 'g'), dataUrl);
    }

    // Send the finished HTML back to the content script to trigger the download
    // (service workers cannot use URL.createObjectURL or <a> click)
    const filename = (tab.title || 'page')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 60) + '_offline.html';

    await send(tab.id, { type: 'DOWNLOAD_HTML', html, filename });
    return { ok: true, count: dataUrlMap.size };
  } catch (err) {
    console.error('FullSnap downloadAssets:', err);
    return { error: 'captureFailed' };
  }
}
