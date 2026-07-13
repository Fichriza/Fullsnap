// FullSnap content script. Injected on demand (activeTab + scripting).
// Drives scrolling, hides sticky elements, shows the progress overlay,
// and implements the drag-to-select mode. All state is torn down on CLEANUP.

(() => {
  if (window.__fullsnapInjected) return;
  window.__fullsnapInjected = true;

  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

  const state = {
    scroller: null,        // element we scroll (document.scrollingElement or inner container)
    isDocScroller: true,
    startScroll: 0,
    styleEl: null,
    hidden: [],            // [{el, value, priority}] visibility overrides to restore
    hiddenSet: null,       // WeakSet of already-hidden elements
    overlay: null,
    overlayBar: null,
    overlayText: null,
    selection: null,
    mapHidden: null
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF stops firing in occluded/background windows — race a timeout so a
  // capture never stalls if the user switches away mid-run.
  const nextFrames = (count = 2) => Promise.race([
    new Promise((resolve) => {
      let left = count;
      const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    }),
    sleep(250)
  ]);

  function findScroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > window.innerHeight + 8) return { el: doc, isDoc: true };
    // Page doesn't scroll at the document level — look for the main inner scroller
    // (app-shell layouts: docs sites, dashboards, chat UIs).
    let best = null;
    let bestHeight = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el.clientHeight < window.innerHeight * 0.5) continue;
      if (el.scrollHeight <= el.clientHeight + 8) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
      if (el.scrollHeight > bestHeight) { best = el; bestHeight = el.scrollHeight; }
    }
    return best ? { el: best, isDoc: false } : { el: doc, isDoc: true };
  }

  function getScrollTop() {
    return state.isDocScroller ? (state.scroller.scrollTop || window.scrollY) : state.scroller.scrollTop;
  }

  function setScrollTop(y) {
    // behavior:'instant' overrides CSS scroll-behavior:smooth even on pages
    // whose CSP blocks our injected style reset.
    if (state.isDocScroller) window.scrollTo({ top: y, behavior: 'instant' });
    else state.scroller.scrollTo({ top: y, behavior: 'instant' });
  }

  // Viewport-relative rect of the area being captured, in CSS px.
  function captureRect() {
    if (state.isDocScroller) {
      return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    }
    const r = state.scroller.getBoundingClientRect();
    const x = Math.max(r.left, 0);
    const y = Math.max(r.top, 0);
    return {
      x, y,
      w: Math.max(1, Math.min(r.right, window.innerWidth) - x),
      h: Math.max(1, Math.min(r.bottom, window.innerHeight) - y)
    };
  }

  // bottomOnly: on the first frame keep the header visible (per PRD) but hide
  // bottom-anchored fixed elements (footers, cookie bars) that would otherwise
  // be burned into the middle of the stitched image.
  function hideStickyElements(bottomOnly = false) {
    if (!state.hiddenSet) state.hiddenSet = new WeakSet();
    for (const el of document.querySelectorAll('*')) {
      if (state.hiddenSet.has(el)) continue;
      if (el === state.overlay) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (bottomOnly && el.getBoundingClientRect().top < window.innerHeight * 0.5) continue;
      state.hidden.push({
        el,
        value: el.style.getPropertyValue('visibility'),
        priority: el.style.getPropertyPriority('visibility')
      });
      state.hiddenSet.add(el);
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  function restoreStickyElements() {
    for (const { el, value, priority } of state.hidden) {
      if (value) el.style.setProperty('visibility', value, priority);
      else el.style.removeProperty('visibility');
    }
    state.hidden = [];
    state.hiddenSet = null;
  }

  function injectCaptureStyle() {
    if (state.styleEl) return;
    const style = document.createElement('style');
    style.textContent = `
      html, body, * { scroll-behavior: auto !important; }
      ::-webkit-scrollbar { display: none !important; }
      html { scrollbar-width: none !important; }
    `;
    document.documentElement.appendChild(style);
    state.styleEl = style;
  }

  function removeCaptureStyle() {
    if (state.styleEl) { state.styleEl.remove(); state.styleEl = null; }
  }

  // ---- Progress overlay (hidden during each captureVisibleTab call) ----

  function createOverlay() {
    if (state.overlay) return;
    const wrap = document.createElement('div');
    wrap.setAttribute('style',
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#111;color:#fff;border:1px solid #333;border-radius:10px;padding:10px 16px;' +
      'display:flex;align-items:center;gap:12px;font:13px/1.4 system-ui,sans-serif;' +
      'box-shadow:0 4px 20px rgba(0,0,0,.35);');
    const text = document.createElement('span');
    text.textContent = t('preparing');
    const barOuter = document.createElement('div');
    barOuter.setAttribute('style',
      'width:140px;height:6px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden;');
    const bar = document.createElement('div');
    bar.setAttribute('style',
      'width:0%;height:100%;background:#fff;border-radius:3px;transition:width .2s;');
    barOuter.appendChild(bar);
    const btn = document.createElement('button');
    btn.textContent = t('cancel');
    btn.setAttribute('style',
      'background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:6px;' +
      'padding:4px 10px;font:12px system-ui,sans-serif;cursor:pointer;');
    btn.addEventListener('click', () => {
      text.textContent = t('cancelling');
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: 'FULLSNAP_CANCEL' });
    });
    wrap.append(text, barOuter, btn);
    document.documentElement.appendChild(wrap);
    state.overlay = wrap;
    state.overlayBar = bar;
    state.overlayText = text;
  }

  function removeOverlay() {
    if (state.overlay) { state.overlay.remove(); state.overlay = null; }
  }

  // ---- Map mode: hide map-service UI chrome for a clean capture ----
  // Attribution/logos are deliberately NOT hidden (map providers' ToS require
  // them to stay visible on captures).

  function mapHideSelectors() {
    const host = location.hostname;
    const sels = [
      // Google Maps JS API embeds (any site)
      '.gmnoprint', '.gm-fullscreen-control', '.gm-svpc',
      // Leaflet (openstreetmap.org and countless others) — everything except attribution
      '.leaflet-control:not(.leaflet-control-attribution)',
      // Mapbox GL
      '.mapboxgl-ctrl-top-left', '.mapboxgl-ctrl-top-right', '.mapboxgl-ctrl-group'
    ];
    if (host.includes('google.')) {
      sels.push('#omnibox-container', '#assistive-chips', '.app-viewcard-strip',
        '#gb', '#QA0Szd', '#minimap', '#settings', '#vasquette',
        '.app-bottom-content-anchor');
    }
    if (host.includes('openstreetmap.org')) {
      sels.push('header', '#sidebar', '.control-button');
    }
    if (host.includes('bing.com')) {
      sels.push('#header', '.headerContainer', '#taskBar', '.actionsContainer', '#sideBar');
    }
    if (host.includes('waze.com')) {
      sels.push('.wm-header', '.wm-cards', '.leaflet-control-container .leaflet-top');
    }
    return sels;
  }

  // Inline CSSOM styles, not an injected <style> element — strict page CSPs
  // (e.g. openstreetmap.org) block inline stylesheets from content scripts,
  // but element.style.setProperty is not subject to CSP.
  function mapPrepare() {
    if (state.mapHidden) return { hidden: state.mapHidden.length, viewportW: window.innerWidth, viewportH: window.innerHeight };
    state.mapHidden = [];
    for (const sel of mapHideSelectors()) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const el of nodes) {
        if (state.mapHidden.some((h) => h.el === el)) continue;
        state.mapHidden.push({
          el,
          value: el.style.getPropertyValue('visibility'),
          priority: el.style.getPropertyPriority('visibility')
        });
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    return { hidden: state.mapHidden.length, viewportW: window.innerWidth, viewportH: window.innerHeight };
  }

  function mapRestore() {
    for (const { el, value, priority } of state.mapHidden || []) {
      if (value) el.style.setProperty('visibility', value, priority);
      else el.style.removeProperty('visibility');
    }
    state.mapHidden = null;
    return { ok: true };
  }

  // Pan the map by (dx, dy) CSS pixels using synthetic pointer drag.
  // Works for Google Maps, Leaflet, Mapbox GL — all listen on the map canvas/div.
  async function mapPan(dx, dy) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const target = document.elementFromPoint(cx, cy) || document.body;
    const fire = (type, x, y) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1
    }));
    fire('pointerdown', cx, cy);
    // Move in small steps so the map renderer doesn't drop the drag
    const steps = Math.max(4, Math.round(Math.sqrt(dx * dx + dy * dy) / 40));
    for (let i = 1; i <= steps; i++) {
      fire('pointermove', cx - dx * (i / steps), cy - dy * (i / steps));
      await sleep(8);
    }
    fire('pointerup', cx - dx, cy - dy);
    // Give the map time to re-render tiles after the pan
    await sleep(600);
    await nextFrames(4);
  }

  // ---- Selection mode ----

  function startSelection() {
    if (state.selection) return;
    const host = document.createElement('div');
    host.setAttribute('style',
      'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;');
    const rect = document.createElement('div');
    rect.setAttribute('style',
      'position:fixed;display:none;border:1.5px dashed #fff;background:transparent;' +
      'box-shadow:0 0 0 200000px rgba(0,0,0,.3);pointer-events:none;');
    const hint = document.createElement('div');
    hint.textContent = t('selectionHint');
    hint.setAttribute('style',
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1e1e2e;' +
      'color:#fff;border-radius:8px;padding:6px 14px;font:13px system-ui,sans-serif;' +
      'pointer-events:none;');
    host.append(rect, hint);
    document.documentElement.appendChild(host);

    let start = null;
    const current = { x: 0, y: 0, w: 0, h: 0 };

    const update = (e) => {
      current.x = Math.min(start.x, e.clientX);
      current.y = Math.min(start.y, e.clientY);
      current.w = Math.abs(e.clientX - start.x);
      current.h = Math.abs(e.clientY - start.y);
      rect.style.display = 'block';
      rect.style.left = current.x + 'px';
      rect.style.top = current.y + 'px';
      rect.style.width = current.w + 'px';
      rect.style.height = current.h + 'px';
    };
    const cleanup = () => {
      host.remove();
      document.removeEventListener('keydown', onKey, true);
      state.selection = null;
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    };
    host.addEventListener('mousedown', (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      hint.style.display = 'none';
    });
    host.addEventListener('mousemove', (e) => { if (start) update(e); });
    host.addEventListener('mouseup', async (e) => {
      if (!start) return;
      update(e);
      cleanup();
      if (current.w < 5 || current.h < 5) return;
      await nextFrames(2);
      await sleep(60); // let the overlay repaint away before capture
      chrome.runtime.sendMessage({
        type: 'SELECTION_MADE',
        rect: current,
        viewportW: window.innerWidth
      });
    });
    document.addEventListener('keydown', onKey, true);
    state.selection = host;
  }

  // ---- Message handling ----

  async function handle(msg) {
    switch (msg.type) {
      case 'PING':
        return { ok: true };

      case 'PREPARE': {
        const found = findScroller();
        state.scroller = found.el;
        state.isDocScroller = found.isDoc;
        state.startScroll = getScrollTop();
        injectCaptureStyle();
        createOverlay();
        return {
          rect: captureRect(),
          totalHeight: state.scroller.scrollHeight,
          viewportW: window.innerWidth,
          startScroll: state.startScroll
        };
      }

      case 'SCROLL_STEP': {
        if (state.overlay) state.overlay.style.display = 'none';
        setScrollTop(msg.y);
        await sleep(Math.max(0, msg.delay | 0));
        await nextFrames(2);
        if (msg.hideSticky) hideStickyElements(msg.first);
        return { y: getScrollTop(), totalHeight: state.scroller.scrollHeight };
      }

      case 'PROGRESS': {
        if (state.overlay) {
          state.overlay.style.display = 'flex';
          state.overlayBar.style.width = msg.percent + '%';
          state.overlayText.textContent = `${t('capturing')} ${msg.percent}%`;
        }
        return { ok: true };
      }

      case 'CLEANUP': {
        restoreStickyElements();
        removeCaptureStyle();
        removeOverlay();
        if (state.scroller) setScrollTop(state.startScroll);
        return { ok: true };
      }

      case 'START_SELECTION': {
        startSelection();
        return { ok: true };
      }

      case 'MAP_PREPARE': {
        const res = mapPrepare();
        await sleep(150);
        await nextFrames(2);
        return res;
      }

      case 'MAP_RESTORE':
        return mapRestore();

      case 'MAP_PAN': {
        await mapPan(msg.dx, msg.dy);
        return { ok: true };
      }

      case 'DOWNLOAD_HTML': {
        const blob = new Blob([msg.html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = msg.filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { ok: true };
      }

      case 'GET_ASSETS': {
        const seen = new Set();
        const urls = [];
        const add = (url) => {
          if (!url) return;
          try {
            const abs = new URL(url, location.href).href;
            if (!seen.has(abs) && /^https?:/.test(abs)) { seen.add(abs); urls.push(abs); }
          } catch {}
        };
        for (const el of document.querySelectorAll('img[src],img[srcset]')) {
          add(el.src);
          for (const part of (el.srcset || '').split(',')) add(part.trim().split(/\s+/)[0]);
        }
        for (const el of document.querySelectorAll('script[src]')) add(el.src);
        for (const el of document.querySelectorAll('link[rel="stylesheet"][href]')) add(el.href);
        for (const el of document.querySelectorAll('link[rel="preload"][href]')) add(el.href);
        for (const el of document.querySelectorAll('video[src],video source[src]')) add(el.src);
        for (const el of document.querySelectorAll('audio[src],audio source[src]')) add(el.src);
        for (const el of document.querySelectorAll('[style]')) {
          const m = el.style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
          if (m) add(m[1]);
        }
        // Serialize the live DOM including all current attribute values
        const doctype = document.doctype
          ? `<!DOCTYPE ${document.doctype.name}>\n`
          : '<!DOCTYPE html>\n';
        const html = doctype + document.documentElement.outerHTML;
        return { urls, html, baseUrl: location.href };
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.__fullsnap) return;
    handle(msg).then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
    return true;
  });
})();
