// 手機上的資料快取：IndexedDB（每個 App 獨立、重開還在）。測試時用記憶體版本。
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    async get(k) { return m.get(k) as any; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
    async keys() { return [...m.keys()]; },
  };
}

export function indexedKV(dbName = "stock-radar"): KV {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction("kv", mode);
      const r = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    get: (k) => run("readonly", (s) => s.get(k)) as any,
    set: async (k, v) => { await run("readwrite", (s) => s.put(v, k)); },
    del: async (k) => { await run("readwrite", (s) => s.delete(k)); },
    keys: async () => (await run("readonly", (s) => s.getAllKeys())).map(String),
  };
}
