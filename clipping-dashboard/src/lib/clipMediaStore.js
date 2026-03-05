const DB_NAME = 'church-of-fun-clip-media';
const DB_VERSION = 1;
const STORE_NAME = 'clip_media';

let dbPromise = null;

const withRequest = (request) => {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
};

const withTransaction = (transaction) => {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  });
};

const openDb = () => {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'clipId' });
          store.createIndex('byProjectId', 'projectId', { unique: false });
          store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
    });
  }

  return dbPromise;
};

export const storeClipMedia = async ({ clipId, projectId, fileName, blob }) => {
  if (!clipId || !blob) return false;
  const db = await openDb();
  if (!db) return false;

  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.put({
    clipId: String(clipId),
    projectId: String(projectId || ''),
    fileName: String(fileName || ''),
    blob,
    sizeBytes: Number(blob.size || 0),
    updatedAt: Date.now(),
  });
  await withTransaction(transaction);
  return true;
};

export const getClipMedia = async (clipId) => {
  if (!clipId) return null;
  const db = await openDb();
  if (!db) return null;

  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const result = await withRequest(store.get(String(clipId)));
  await withTransaction(transaction);
  return result || null;
};

export const deleteClipMedia = async (clipId) => {
  if (!clipId) return;
  const db = await openDb();
  if (!db) return;

  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.delete(String(clipId));
  await withTransaction(transaction);
};

export const deleteProjectClipMedia = async (projectId) => {
  if (!projectId) return;
  const db = await openDb();
  if (!db) return;
  const KeyRange = window.IDBKeyRange;
  if (!KeyRange) return;

  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const index = store.index('byProjectId');
  const cursorRequest = index.openCursor(KeyRange.only(String(projectId)));

  await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Failed to delete project media.'));
  });

  await withTransaction(transaction);
};

export const getClipMediaStats = async () => {
  const db = await openDb();
  if (!db) return { totalBytes: 0, clipCount: 0 };

  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const cursorRequest = store.openCursor();
  let totalBytes = 0;
  let clipCount = 0;

  await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      clipCount += 1;
      totalBytes += Number(cursor.value?.sizeBytes || 0);
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Failed to read media stats.'));
  });

  await withTransaction(transaction);
  return { totalBytes, clipCount };
};

export const trimClipMediaStore = async ({ maxBytes, protectedClipIds = [] }) => {
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) <= 0) return [];
  const db = await openDb();
  if (!db) return [];

  const protectedSet = new Set(
    Array.isArray(protectedClipIds) ? protectedClipIds.map((value) => String(value)) : []
  );

  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const cursorRequest = store.openCursor();
  const records = [];

  await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      records.push({
        clipId: String(cursor.value?.clipId || ''),
        sizeBytes: Number(cursor.value?.sizeBytes || 0),
        updatedAt: Number(cursor.value?.updatedAt || 0),
      });
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Failed to scan media store.'));
  });
  await withTransaction(transaction);

  let totalBytes = records.reduce((sum, record) => sum + record.sizeBytes, 0);
  if (totalBytes <= maxBytes) return [];

  const candidates = records
    .filter((record) => record.clipId && !protectedSet.has(record.clipId))
    .sort((a, b) => a.updatedAt - b.updatedAt);

  const removedClipIds = [];
  const removeTransaction = db.transaction(STORE_NAME, 'readwrite');
  const removeStore = removeTransaction.objectStore(STORE_NAME);

  for (const candidate of candidates) {
    if (totalBytes <= maxBytes) break;
    removeStore.delete(candidate.clipId);
    removedClipIds.push(candidate.clipId);
    totalBytes -= candidate.sizeBytes;
  }

  await withTransaction(removeTransaction);
  return removedClipIds;
};
