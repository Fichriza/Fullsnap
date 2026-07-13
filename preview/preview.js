// FullSnap preview page: stitches captured slices into canvases, offers
// zoom / crop / copy / PNG / JPEG / PDF export. Everything runs locally.

import { getCapture } from '../src/lib/db.js';
import { getSettings } from '../src/lib/settings.js';
import { createPdf } from '../src/lib/pdf.js';
import { applyI18n, applyTheme, buildFilename, formatBytes, t } from '../src/lib/util.js';

// Chrome caps a canvas dimension around 16384px at common widths; stay under it
// and split very tall captures into stacked segments.
const MAX_SEGMENT_HEIGHT = 16000;
const PAPER_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
const MARGINS = { none: 0, small: 18, normal: 36 };
const PX_TO_PT = 72 / 96; // CSS px -> PDF points
const MAX_PAGE_PT = 14400; // PDF page size limit (200 inches)

const els = {
  wrap: document.getElementById('canvasWrap'),
  loading: document.getElementById('loading'),
  fileLabel: document.getElementById('fileLabel'),
  infoDims: document.getElementById('infoDims'),
  infoUrl: document.getElementById('infoUrl'),
  multiPartNote: document.getElementById('multiPartNote'),
  zoomSelect: document.getElementById('zoomSelect'),
  cropOverlay: document.getElementById('cropOverlay'),
  cropRect: document.getElementById('cropRect'),
  btnCrop: document.getElementById('btnCrop'),
  cropActions: document.getElementById('cropActions'),
  toast: document.getElementById('toast')
};

const state = {
  meta: null,
  settings: null,
  segments: [],      // [{ canvas, y0 }] y0 = device-px offset of segment top
  fullWidth: 0,      // device px
  fullHeight: 0,     // device px
  captureScale: 1,   // device px per CSS px
  cropSelection: null
};

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3000);
}

// ---------- Stitching ----------

async function buildSegments(meta, blobs) {
  const bitmaps = await Promise.all(blobs.map((b) => createImageBitmap(b)));
  const first = bitmaps[0];
  const scale = meta.viewportW ? first.width / meta.viewportW : 1;
  state.captureScale = scale;

  if (meta.mode === 'visible' || meta.mode === 'map') {
    // NxN grid map: stitch N² slices into one large canvas
    if (meta.mode === 'map' && meta.grid > 1) {
      const n = meta.grid;
      const bitmaps = await Promise.all(blobs.map((b) => createImageBitmap(b)));
      const tw = bitmaps[0].width;
      const th = bitmaps[0].height;
      const canvas = document.createElement('canvas');
      canvas.width = tw * n;
      canvas.height = th * n;
      const ctx = canvas.getContext('2d');
      bitmaps.forEach((bmp, i) => {
        const col = i % n;
        const row = Math.floor(i / n);
        ctx.drawImage(bmp, col * tw, row * th);
        bmp.close();
      });
      state.captureScale = meta.viewportW ? tw / meta.viewportW : 1;
      return [{ canvas, y0: 0, grid: n }];
    }
    const seg = singleSegmentFromRegion(first, 0, 0, first.width, first.height);
    return [seg];
  }

  if (meta.mode === 'selection') {
    const c = meta.crop;
    return [singleSegmentFromRegion(
      first,
      Math.round(c.x * scale), Math.round(c.y * scale),
      Math.max(1, Math.round(c.w * scale)), Math.max(1, Math.round(c.h * scale))
    )];
  }

  // Full page: place each slice at its scroll position.
  const rect = meta.rect;
  const width = Math.max(1, Math.round(rect.w * scale));
  const totalHeight = Math.max(1, Math.round(meta.heightCss * scale));

  const segments = [];
  for (let y0 = 0; y0 < totalHeight; y0 += MAX_SEGMENT_HEIGHT) {
    const h = Math.min(MAX_SEGMENT_HEIGHT, totalHeight - y0);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, h);
    segments.push({ canvas, ctx, y0 });
  }

  bitmaps.forEach((bmp, i) => {
    const sliceY = Math.round(meta.positions[i] * scale);
    const srcX = Math.round(rect.x * scale);
    const srcY = Math.round(rect.y * scale);
    const sliceH = Math.min(Math.round(rect.h * scale), bmp.height - srcY, totalHeight - sliceY);
    if (sliceH <= 0) return;
    for (const seg of segments) {
      const top = Math.max(sliceY, seg.y0);
      const bottom = Math.min(sliceY + sliceH, seg.y0 + seg.canvas.height);
      if (bottom <= top) continue;
      seg.ctx.drawImage(
        bmp,
        srcX, srcY + (top - sliceY), width, bottom - top,
        0, top - seg.y0, width, bottom - top
      );
    }
  });

  bitmaps.forEach((b) => b.close());
  return segments.map(({ canvas, y0 }) => ({ canvas, y0 }));
}

function singleSegmentFromRegion(bmp, sx, sy, w, h) {
  w = Math.min(w, bmp.width - sx);
  h = Math.min(h, bmp.height - sy);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
  bmp.close();
  return { canvas, y0: 0 };
}

function setSegments(segments) {
  state.segments = segments;
  state.fullWidth = segments[0].canvas.width;
  state.fullHeight = segments.reduce((sum, s) => sum + s.canvas.height, 0);

  for (const old of els.wrap.querySelectorAll('canvas')) old.remove();
  for (const seg of segments) els.wrap.insertBefore(seg.canvas, els.cropOverlay);

  els.infoDims.textContent = `${state.fullWidth} × ${state.fullHeight} px`;
  els.btnCrop.hidden = segments.length !== 1;
  if (segments.length > 1) {
    els.multiPartNote.textContent = t('multiPartNote', [String(segments.length)]);
    els.multiPartNote.hidden = false;
  } else {
    els.multiPartNote.hidden = true;
  }

  // Show grid overlay and download-tiles button when meta has grid
  const grid = state.meta && state.meta.grid;
  const gridPanel = document.getElementById('gridPanel');
  if (grid > 1 && segments.length === 1) {
    drawGridOverlay(segments[0].canvas, grid);
    gridPanel.hidden = false;
    document.getElementById('gridLabel').textContent = `${grid}×${grid}`;
  } else {
    removeGridOverlay();
    gridPanel.hidden = true;
  }

  applyZoom();
}

// ---------- Grid overlay ----------

function drawGridOverlay(canvas, n) {
  removeGridOverlay();
  const overlay = document.createElement('canvas');
  overlay.id = 'gridOverlayCanvas';
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  overlay.style.cssText = canvas.style.cssText;
  overlay.style.position = 'absolute';
  overlay.style.top = canvas.offsetTop + 'px';
  overlay.style.left = canvas.offsetLeft + 'px';
  overlay.style.pointerEvents = 'none';
  const ctx = overlay.getContext('2d');
  ctx.strokeStyle = 'rgba(255,0,0,0.7)';
  ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
  const tw = canvas.width / n;
  const th = canvas.height / n;
  for (let i = 1; i < n; i++) {
    ctx.beginPath(); ctx.moveTo(tw * i, 0); ctx.lineTo(tw * i, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, th * i); ctx.lineTo(canvas.width, th * i); ctx.stroke();
  }
  // label each tile col×row
  ctx.fillStyle = 'rgba(255,0,0,0.85)';
  ctx.font = `bold ${Math.max(14, Math.round(canvas.width / (n * 12)))}px system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      ctx.fillText(`${r + 1},${c + 1}`, tw * c + tw / 2, th * r + th / 2);
    }
  }
  canvas.parentNode.style.position = 'relative';
  canvas.insertAdjacentElement('afterend', overlay);
}

function removeGridOverlay() {
  const el = document.getElementById('gridOverlayCanvas');
  if (el) el.remove();
}

function downloadTiles(n) {
  const src = state.segments[0].canvas;
  const tw = Math.floor(src.width / n);
  const th = Math.floor(src.height / n);
  const base = state.meta.title ? state.meta.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) : 'map';
  const fmt = state.settings.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const ext = fmt === 'image/jpeg' ? 'jpg' : 'png';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const tile = document.createElement('canvas');
      tile.width = tw; tile.height = th;
      tile.getContext('2d').drawImage(src, c * tw, r * th, tw, th, 0, 0, tw, th);
      const a = document.createElement('a');
      a.download = `${base}_tile_${r + 1}-${c + 1}.${ext}`;
      a.href = tile.toDataURL(fmt, 0.92);
      a.click();
    }
  }
}

// Compose an arbitrary horizontal band (device px) across segments into one canvas.
function composeRegion(yDev, hDev) {
  const canvas = document.createElement('canvas');
  canvas.width = state.fullWidth;
  canvas.height = hDev;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const seg of state.segments) {
    const top = Math.max(yDev, seg.y0);
    const bottom = Math.min(yDev + hDev, seg.y0 + seg.canvas.height);
    if (bottom <= top) continue;
    ctx.drawImage(
      seg.canvas,
      0, top - seg.y0, state.fullWidth, bottom - top,
      0, top - yDev, state.fullWidth, bottom - top
    );
  }
  return canvas;
}

// ---------- Zoom ----------

function applyZoom() {
  const mode = els.zoomSelect.value;
  const naturalCssWidth = state.fullWidth / state.captureScale;
  let displayWidth;
  if (mode === 'fit') {
    const area = document.getElementById('canvasArea');
    displayWidth = Math.min(naturalCssWidth, area.clientWidth - 48);
  } else {
    displayWidth = naturalCssWidth * parseFloat(mode);
  }
  for (const seg of state.segments) {
    seg.canvas.style.width = displayWidth + 'px';
  }
}

// ---------- Export helpers ----------

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality);
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

async function downloadImage(format) {
  const ext = format === 'png' ? 'png' : 'jpg';
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = format === 'png' ? undefined : state.settings.jpegQuality / 100;
  const base = buildFilename(state.settings.filenamePattern, state.meta.title, ext);
  let total = 0;
  for (let i = 0; i < state.segments.length; i++) {
    const blob = await canvasToBlob(state.segments[i].canvas, type, quality);
    total += blob.size;
    const name = state.segments.length === 1
      ? base
      : base.replace(`.${ext}`, `_part${i + 1}.${ext}`);
    download(blob, name);
  }
  toast(`${t('downloaded')} (${formatBytes(total)})`);
}

async function copyToClipboard() {
  try {
    // Multi-segment captures exceed canvas limits — copy the first part.
    const blob = await canvasToBlob(state.segments[0].canvas, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(t('copied'));
  } catch (err) {
    console.error(err);
    toast(t('copyFailed'));
  }
}

// ---------- PDF ----------

async function generatePdf() {
  const paper = document.querySelector('input[name="paper"]:checked').value;
  const orient = document.querySelector('input[name="orient"]:checked').value;
  const margin = MARGINS[document.querySelector('input[name="pmargin"]:checked').value];
  const withMeta = document.getElementById('pdfMeta').checked;

  const cssW = state.fullWidth / state.captureScale;
  const cssH = state.fullHeight / state.captureScale;
  const quality = Math.max(0.6, state.settings.jpegQuality / 100);
  const pages = [];

  if (paper === 'fit') {
    const drawW = cssW * PX_TO_PT;
    const pageW = drawW + margin * 2;
    const maxChunkCss = (MAX_PAGE_PT - margin * 2) / PX_TO_PT;
    for (let yCss = 0; yCss < cssH; yCss += maxChunkCss) {
      const chunkCss = Math.min(maxChunkCss, cssH - yCss);
      pages.push(await makePage(yCss, chunkCss, {
        pageWidth: pageW,
        pageHeight: chunkCss * PX_TO_PT + margin * 2,
        x: margin,
        drawWidth: drawW,
        drawHeight: chunkCss * PX_TO_PT
      }, quality));
    }
  } else {
    let [pw, ph] = PAPER_SIZES[paper];
    if (orient === 'landscape') [pw, ph] = [ph, pw];
    const contentW = pw - margin * 2;
    const contentH = ph - margin * 2;
    const ptPerCssPx = contentW / cssW;
    const chunkCssMax = contentH / ptPerCssPx;
    for (let yCss = 0; yCss < cssH; yCss += chunkCssMax) {
      const chunkCss = Math.min(chunkCssMax, cssH - yCss);
      const drawH = chunkCss * ptPerCssPx;
      pages.push(await makePage(yCss, chunkCss, {
        pageWidth: pw,
        pageHeight: ph,
        x: margin,
        y: ph - margin - drawH, // top-aligned within content box
        drawWidth: contentW,
        drawHeight: drawH
      }, quality));
    }
  }

  const info = withMeta
    ? { title: state.meta.title, subject: state.meta.url, creator: 'FullSnap' }
    : {};
  const bytes = createPdf({ pages, info });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  download(blob, buildFilename(state.settings.filenamePattern, state.meta.title, 'pdf'));
  toast(`${t('pdfSaved')} (${formatBytes(blob.size)})`);
}

async function makePage(yCss, hCss, layout, quality) {
  const yDev = Math.round(yCss * state.captureScale);
  const hDev = Math.max(1, Math.round(hCss * state.captureScale));
  const chunk = composeRegion(yDev, hDev);
  const blob = await canvasToBlob(chunk, 'image/jpeg', quality);
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  return {
    jpeg,
    widthPx: chunk.width,
    heightPx: chunk.height,
    pageWidth: layout.pageWidth,
    pageHeight: layout.pageHeight,
    x: layout.x,
    // Default: top-aligned image (equals the margin for fit-to-image pages).
    y: layout.y !== undefined ? layout.y : layout.pageHeight - layout.drawHeight - layout.x,
    drawWidth: layout.drawWidth,
    drawHeight: layout.drawHeight
  };
}

// ---------- OCR (Tesseract.js, fully local — engine + language data bundled) ----------

let ocrBusy = false;

async function runOcr() {
  if (ocrBusy) return;
  ocrBusy = true;
  const btn = document.getElementById('btnOcr');
  const panel = document.getElementById('ocrPanel');
  const status = document.getElementById('ocrStatus');
  const textarea = document.getElementById('ocrText');
  const actions = document.getElementById('ocrActions');
  btn.disabled = true;
  panel.hidden = false;
  textarea.hidden = true;
  actions.hidden = true;
  status.textContent = t('ocrLoading');

  let worker = null;
  try {
    worker = await Tesseract.createWorker(state.settings.ocrLang, 1, {
      workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('vendor/tesseract/'),
      langPath: chrome.runtime.getURL('vendor/tessdata'),
      workerBlobURL: false,
      gzip: true,
      logger: (m) => {
        if (m.status === 'recognizing text') {
          status.textContent = `${t('ocrRecognizing')} ${Math.round(m.progress * 100)}%`;
        }
      }
    });
    let text = '';
    for (let i = 0; i < state.segments.length; i++) {
      status.textContent = `${t('ocrRecognizing')} (${i + 1}/${state.segments.length})`;
      const { data } = await worker.recognize(state.segments[i].canvas);
      text += data.text + '\n';
    }
    textarea.value = text.replace(/\n{3,}/g, '\n\n').trim();
    textarea.hidden = false;
    actions.hidden = false;
    status.textContent = t('ocrDone');
  } catch (err) {
    console.error(err);
    status.textContent = `${t('ocrFailed')}: ${err.message || err}`;
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    btn.disabled = false;
    ocrBusy = false;
  }
}

function setupOcr() {
  document.getElementById('btnOcr').addEventListener('click', runOcr);
  document.getElementById('btnOcrCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById('ocrText').value);
    toast(t('copied'));
  });
  document.getElementById('btnOcrTxt').addEventListener('click', () => {
    const blob = new Blob([document.getElementById('ocrText').value], { type: 'text/plain;charset=utf-8' });
    download(blob, buildFilename(state.settings.filenamePattern, state.meta.title, 'txt'));
    toast(t('downloaded'));
  });
}

// ---------- Crop ----------

function enterCropMode() {
  els.cropOverlay.hidden = false;
  els.cropActions.hidden = false;
  els.btnCrop.disabled = true;
  state.cropSelection = null;
  els.cropRect.style.display = 'none';
}

function exitCropMode() {
  els.cropOverlay.hidden = true;
  els.cropActions.hidden = true;
  els.btnCrop.disabled = false;
  state.cropSelection = null;
  els.cropRect.style.display = 'none';
}

function setupCrop() {
  let start = null;
  els.cropOverlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const box = els.cropOverlay.getBoundingClientRect();
    start = { x: e.clientX - box.left, y: e.clientY - box.top };
  });
  els.cropOverlay.addEventListener('mousemove', (e) => {
    if (!start) return;
    const box = els.cropOverlay.getBoundingClientRect();
    const cur = { x: e.clientX - box.left, y: e.clientY - box.top };
    const sel = {
      x: Math.max(0, Math.min(start.x, cur.x)),
      y: Math.max(0, Math.min(start.y, cur.y)),
      w: Math.abs(cur.x - start.x),
      h: Math.abs(cur.y - start.y)
    };
    state.cropSelection = sel;
    Object.assign(els.cropRect.style, {
      display: 'block',
      left: sel.x + 'px', top: sel.y + 'px',
      width: sel.w + 'px', height: sel.h + 'px'
    });
  });
  window.addEventListener('mouseup', () => { start = null; });

  els.btnCrop.addEventListener('click', enterCropMode);
  document.getElementById('btnCropCancel').addEventListener('click', exitCropMode);
  document.getElementById('btnCropApply').addEventListener('click', () => {
    const sel = state.cropSelection;
    if (!sel || sel.w < 4 || sel.h < 4) { exitCropMode(); return; }
    const canvas = state.segments[0].canvas;
    const displayW = canvas.getBoundingClientRect().width;
    const ratio = canvas.width / displayW;
    const sx = Math.round(sel.x * ratio);
    const sy = Math.round(sel.y * ratio);
    const sw = Math.max(1, Math.min(Math.round(sel.w * ratio), canvas.width - sx));
    const sh = Math.max(1, Math.min(Math.round(sel.h * ratio), canvas.height - sy));
    const cropped = document.createElement('canvas');
    cropped.width = sw;
    cropped.height = sh;
    cropped.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    exitCropMode();
    setSegments([{ canvas: cropped, y0: 0 }]);
  });
}

// ---------- Init ----------

async function init() {
  applyI18n();
  applyTheme();
  document.title = t('previewTitle');

  state.settings = await getSettings();

  const id = new URLSearchParams(location.search).get('id');
  const capture = id ? await getCapture(id).catch(() => null) : null;
  if (!capture) {
    els.loading.textContent = t('loadFailed');
    return;
  }
  state.meta = capture.meta;

  els.fileLabel.textContent = buildFilename(
    state.settings.filenamePattern, state.meta.title, state.settings.format === 'png' ? 'png' : 'jpg');
  els.infoUrl.textContent = state.meta.url;
  els.infoUrl.href = state.meta.url;

  const segments = await buildSegments(capture.meta, capture.blobs);
  els.loading.remove();
  setSegments(segments);

  // PDF option defaults from settings
  document.querySelector(`input[name="paper"][value="${state.settings.pdfPaper}"]`).checked = true;
  document.querySelector(`input[name="orient"][value="${state.settings.pdfOrientation}"]`).checked = true;
  document.querySelector(`input[name="pmargin"][value="${state.settings.pdfMargin}"]`).checked = true;
  document.getElementById('pdfMeta').checked = state.settings.pdfMetadata;
  syncOrientEnabled();

  els.zoomSelect.value = 'fit';
  applyZoom();
  els.zoomSelect.addEventListener('change', applyZoom);
  window.addEventListener('resize', () => {
    if (els.zoomSelect.value === 'fit') applyZoom();
  });

  document.getElementById('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('btnPng').addEventListener('click', () => downloadImage('png'));
  document.getElementById('btnJpeg').addEventListener('click', () => downloadImage('jpeg'));
  document.getElementById('btnCopy').addEventListener('click', copyToClipboard);
  document.getElementById('btnPdf').addEventListener('click', () => {
    const btn = document.getElementById('btnPdf');
    btn.disabled = true;
    generatePdf().catch((err) => { console.error(err); toast(String(err)); })
      .finally(() => { btn.disabled = false; });
  });

  const pdfPanel = document.getElementById('pdfPanel');
  document.getElementById('btnPdfToggle').addEventListener('click', () => {
    pdfPanel.hidden = !pdfPanel.hidden;
  });
  for (const input of document.querySelectorAll('input[name="paper"]')) {
    input.addEventListener('change', syncOrientEnabled);
  }

  setupCrop();
  setupOcr();

  // Grid tile download button (map mode with NxN grid)
  const btnDownloadTiles = document.getElementById('btnDownloadTiles');
  if (btnDownloadTiles) {
    btnDownloadTiles.addEventListener('click', () => {
      const grid = state.meta && state.meta.grid;
      if (grid > 1) downloadTiles(grid);
    });
  }

  // Popup quick option "Output: PDF" — pre-open the PDF panel.
  if (state.settings.output === 'pdf') pdfPanel.hidden = false;
}

function syncOrientEnabled() {
  const isFit = document.querySelector('input[name="paper"]:checked').value === 'fit';
  for (const input of document.querySelectorAll('input[name="orient"]')) {
    input.disabled = isFit;
  }
}

init();
