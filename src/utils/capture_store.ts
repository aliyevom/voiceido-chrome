/**
 * IndexedDB store for stitched capture PNGs.
 *
 * Chrome extension IPC (runtime messages *and* some IndexedDB writes from
 * an offscreen document) rejects structured-clone payloads over 64 MiB.
 * Storing several large PNG blobs in one transaction trips that limit, so
 * we persist each image as 16 MiB chunks, one transaction per chunk.
 */

const DB_NAME = 'voiceido-captures';
const DB_VERSION = 2;
const STORE = 'images';
/** Stay well under Chrome's 64 MiB structured-clone cap. */
const CHUNK_BYTES = 16 * 1024 * 1024;

interface CaptureMetaRecord {
  key: string;
  sessionId: string;
  kind: 'meta';
  index: number;
  width: number;
  height: number;
  chunkCount: number;
  byteLength: number;
}

interface CaptureChunkRecord {
  key: string;
  sessionId: string;
  kind: 'chunk';
  index: number;
  chunk: number;
  bytes: ArrayBuffer;
}

function metaKey(sessionId: string, index: number): string {
  return `${sessionId}:meta:${index}`;
}

function chunkKey(sessionId: string, index: number, chunk: number): string {
  return `${sessionId}:chunk:${index}:${chunk}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('sessionId', 'sessionId', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

function withTransaction(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
  });
}

export async function putCaptureImages(
  sessionId: string,
  images: Array<{ blob: Blob; width: number; height: number }>,
): Promise<void> {
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    if (!image) continue;
    await putCaptureImage(sessionId, index, image);
  }
}

export async function putCaptureImage(
  sessionId: string,
  index: number,
  image: { blob: Blob; width: number; height: number },
): Promise<void> {
  const bytes = new Uint8Array(await image.blob.arrayBuffer());
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  const db = await openDb();
  try {
    const meta: CaptureMetaRecord = {
      key: metaKey(sessionId, index),
      sessionId,
      kind: 'meta',
      index,
      width: image.width,
      height: image.height,
      chunkCount,
      byteLength: bytes.byteLength,
    };
    await withTransaction(db, 'readwrite', (store) => {
      store.put(meta);
    });

    for (let chunk = 0; chunk < chunkCount; chunk++) {
      const start = chunk * CHUNK_BYTES;
      const slice = bytes.slice(start, start + CHUNK_BYTES);
      const record: CaptureChunkRecord = {
        key: chunkKey(sessionId, index, chunk),
        sessionId,
        kind: 'chunk',
        index,
        chunk,
        bytes: slice.buffer,
      };
      await withTransaction(db, 'readwrite', (store) => {
        store.put(record);
      });
    }
  } finally {
    db.close();
  }
}

export async function getCaptureImage(sessionId: string, index: number): Promise<Blob> {
  const db = await openDb();
  try {
    const meta = await new Promise<CaptureMetaRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(metaKey(sessionId, index));
      request.onsuccess = () => resolve(request.result as CaptureMetaRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error('indexedDB get failed'));
    });
    if (!meta || meta.kind !== 'meta') {
      throw new Error(`Capture image ${index} is missing. The session may have expired.`);
    }

    const parts: ArrayBuffer[] = [];
    for (let chunk = 0; chunk < meta.chunkCount; chunk++) {
      const record = await new Promise<CaptureChunkRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(chunkKey(sessionId, index, chunk));
        request.onsuccess = () => resolve(request.result as CaptureChunkRecord | undefined);
        request.onerror = () => reject(request.error ?? new Error('indexedDB chunk get failed'));
      });
      if (!record?.bytes) {
        throw new Error(`Capture image ${index} chunk ${chunk} is missing.`);
      }
      parts.push(record.bytes);
    }
    return new Blob(parts, { type: 'image/png' });
  } finally {
    db.close();
  }
}

export async function deleteCaptureImages(sessionId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const sessionIndex = tx.objectStore(STORE).index('sessionId');
      const request = sessionIndex.openCursor(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
    });
  } finally {
    db.close();
  }
}
