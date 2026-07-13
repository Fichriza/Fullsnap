# FullSnap — Full Page Screenshot to PDF

Chrome extension (Manifest V3) that captures a **full web page** via automatic
scroll & capture, stitches the frames into one image, and saves it as **PNG,
JPEG, or PDF** — entirely locally, with no data ever leaving the browser.

Built from [PRD-FullPage-Screenshot-Extension.md](https://github.com/) v1.0 (12 Jul 2026).

## Install (developer mode)

1. Open `chrome://extensions` in Chrome (110+) or any Chromium browser (Edge/Brave).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`Snap Shot`).
4. Pin the 📸 FullSnap icon to the toolbar.

## Usage

1. Open any web page and click the FullSnap icon (or press `Ctrl+Shift+S`).
2. Pick a mode:
   - **Full Page (Auto)** — auto-scrolls top to bottom and stitches every frame.
   - **Visible** — captures just the current viewport.
   - **Select** — drag a rectangle to capture an area.
   - **Map** — clean map capture on Google Maps, OpenStreetMap, Bing Maps,
     Waze, and any Leaflet/Mapbox/Google-Maps-API embed: search bars, side
     panels, and zoom controls are hidden for the shot (attribution stays).
3. A progress pill appears during capture; click **Cancel** to abort.
4. The preview tab opens: zoom, crop, **Copy**, download **PNG/JPEG**, or
   **Save as PDF** (fit-to-image, or paginated A4/Letter with orientation and
   margin options).

## Features (per PRD)

| Feature | Status |
|---|---|
| Full-page capture with auto-scroll + stitching (F1) | ✅ |
| Sticky/fixed element handling — header kept on 1st frame, bottom-anchored (footers/cookie bars) hidden everywhere (F1) | ✅ |
| Lazy-load delay, max-height cap for infinite scroll (F1) | ✅ (configurable) |
| Inner-scroll-container detection (F1) | ✅ best-effort heuristic |
| Progress indicator + cancel (F1) | ✅ |
| Scroll position restored after capture (F1) | ✅ |
| Visible & selected-area modes (F2) | ✅ |
| Map mode — clean capture of Google Maps / OSM / Leaflet / Mapbox (hides search & controls, keeps attribution) | ✅ |
| PNG/JPEG output, auto file naming, chrome.downloads (F3) | ✅ |
| Copy to clipboard (F3) | ✅ |
| PDF fit-to-image + paginated A4/Letter, margins, metadata — 100% local (F4) | ✅ |
| Preview tab with zoom + basic crop (F5) | ✅ |
| Options page (F6) | ✅ |
| Keyboard shortcut `Ctrl/Cmd+Shift+S` | ✅ |
| i18n English + Bahasa Indonesia | ✅ |
| Light/dark theme | ✅ |
| OCR text extraction (Tesseract.js, fully local, eng/ind) | ✅ |
| Capture history | ⬜ deferred (P2) |

## Architecture

```
popup / shortcut ──▶ service worker (src/background.js)
                        │  chrome.scripting → src/content.js
                        │    · finds the scroll container, measures the page
                        │    · scrolls step-by-step, hides sticky elements
                        │    · progress overlay + cancel
                        │  chrome.tabs.captureVisibleTab per step (rate-limited ~2/s)
                        ▼
                    IndexedDB (slices as blobs)
                        ▼
                preview tab (preview/preview.js)
                    · stitches slices on canvas (auto-segments >16k px)
                    · crop / zoom / copy
                    · PNG/JPEG encode · PDF via src/lib/pdf.js (local writer)
```

- **Permissions:** `activeTab`, `scripting`, `downloads`, `storage` only — no
  host permissions, no remote code, no telemetry.
- **PDF:** `src/lib/pdf.js` is a small dependency-free PDF writer that embeds
  JPEG frames via `DCTDecode` — no server, no third-party library.
- **OCR:** Tesseract.js + WASM core + English/Indonesian language data are all
  bundled in `vendor/` (~22 MB), so text extraction works offline and no image
  ever leaves the browser. The manifest CSP adds `wasm-unsafe-eval` for this.
- **UI:** IBM Plex Mono (bundled in `fonts/`, no remote font requests) with a
  minimalist monochrome (black & white) light/dark design.
- **Map mode:** hides map-service UI via inline CSSOM styles (immune to strict
  page CSPs like openstreetmap.org's) and restores it after one frame is
  captured. Provider attribution/logos are intentionally left visible.
- Very tall captures are split into segments (canvas dimension limit); the PDF
  export recombines all segments automatically.

### Note on tech stack

The PRD proposes TypeScript + React + Vite + CRXJS. This v0.1 implementation
deliberately uses **zero-build vanilla JS** so the extension loads directly via
"Load unpacked" with no toolchain. The module boundaries (popup / preview /
options / background / content / lib) mirror the PRD architecture, so a later
migration to the TS/React stack can happen per-surface without redesign.

## Known limitations (per PRD §7)

- Cannot capture `chrome://` pages, the Chrome Web Store, or the built-in PDF
  viewer (a clear message is shown).
- Cross-origin iframes are captured as rendered, but their inner content cannot
  be scrolled (out of scope v1).
- Crop is available for single-segment captures only.
- OCR accuracy is best on regular dark-on-light body text; stylized or
  low-contrast text (e.g. white on saturated colors) may be missed.
