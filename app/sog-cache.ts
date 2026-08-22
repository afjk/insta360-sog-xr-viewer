/**
 * 生成したVR向けSOGをIndexedDBへ残すキャッシュ。
 *
 * キーは「SOGの中身のSHA-256」「目標splat数」「最適化設定」「オプティマイザ版」で、
 * 入力がInsta360共有URLでもローカルファイルでも、実体が同じなら同じキャッシュに当たる。
 */
export type CachedOptimization = {
  key: string;
  sourceHash: string;
  targetSplats: number;
  dropSphericalHarmonics: boolean;
  optimizerVersion: number;
  splats: number;
  sourceSplats: number;
  bytes: number;
  createdAt: number;
  blob: Blob;
};

const DATABASE_NAME = "insta360-sog-xr-viewer";
const DATABASE_VERSION = 1;
const STORE_NAME = "vr-optimized";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("このブラウザではIndexedDBを利用できません。"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDBを開けませんでした。"));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("キャッシュを操作できませんでした。"));
        transaction.oncomplete = () => database.close();
        transaction.onabort = () => database.close();
      }),
  );
}

/** キャッシュは無くても動くべきなので、失敗はnullとして扱う。 */
export async function readCachedOptimization(key: string): Promise<CachedOptimization | null> {
  try {
    const entry = await runTransaction<CachedOptimization | undefined>("readonly", (store) =>
      store.get(key) as IDBRequest<CachedOptimization | undefined>,
    );
    return entry ?? null;
  } catch {
    return null;
  }
}

export async function writeCachedOptimization(entry: CachedOptimization): Promise<boolean> {
  try {
    await runTransaction("readwrite", (store) => store.put(entry));
    return true;
  } catch {
    return false;
  }
}
