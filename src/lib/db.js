// IndexedDB storage for capture slices. The service worker writes slices here,
// the preview tab reads them back — avoids pushing multi-MB payloads through
// runtime messages and keeps the service worker memory footprint small.

const DB_NAME = 'fullsnap';
const DB_VERSION = 1;
const KEEP_CAPTURES = 5;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('captures')) {
        db.createObjectStore('captures', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('slices')) {
        db.createObjectStore('slices', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveCapture(meta, blobs) {
  const db = await openDb();
  const tx = db.transaction(['captures', 'slices'], 'readwrite');
  tx.objectStore('captures').put(meta);
  const slices = tx.objectStore('slices');
  blobs.forEach((blob, i) => slices.put({ key: `${meta.id}:${i}`, blob }));
  await txDone(tx);
  db.close();
}

export async function getCapture(id) {
  const db = await openDb();
  const tx = db.transaction(['captures', 'slices'], 'readonly');
  const meta = await reqAsPromise(tx.objectStore('captures').get(id));
  if (!meta) { db.close(); return null; }
  const blobs = [];
  for (let i = 0; i < meta.sliceCount; i++) {
    const rec = await reqAsPromise(tx.objectStore('slices').get(`${id}:${i}`));
    if (!rec) { db.close(); return null; }
    blobs.push(rec.blob);
  }
  db.close();
  return { meta, blobs };
}

export async function cleanupOldCaptures() {
  const db = await openDb();
  const tx = db.transaction(['captures', 'slices'], 'readwrite');
  const store = tx.objectStore('captures');
  const all = await reqAsPromise(store.getAll());
  all.sort((a, b) => b.ts - a.ts);
  for (const meta of all.slice(KEEP_CAPTURES)) {
    store.delete(meta.id);
    for (let i = 0; i < meta.sliceCount; i++) {
      tx.objectStore('slices').delete(`${meta.id}:${i}`);
    }
  }
  await txDone(tx);
  db.close();
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
