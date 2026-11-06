// Persistent storage for the standalone PrePro build (songs in IndexedDB, optional AI settings on this device).
window.PREPRO_STORE = (() => {
  let db = null;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = mode => db.transaction('songs', mode).objectStore('songs');
  return {
    persistent: true,
    async open() {
      if (db) return true;
      db = await new Promise((res, rej) => {
        const r = indexedDB.open('prepro', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        setTimeout(() => rej(new Error('timeout')), 3000);
      });
      return true;
    },
    put: rec => req(tx('readwrite').put(rec)),
    get: id => req(tx('readonly').get(id)),
    del: id => req(tx('readwrite').delete(id)),
    async list() { const all = await req(tx('readonly').getAll()); return all.map(({ id, name, updated, size, tracks }) => ({ id, name, updated, size, tracks })).sort((a, b) => b.updated - a.updated); },
    loadAI() { return JSON.parse(localStorage.getItem('prepro-ai') || 'null'); },
    getPref(k) { const v = localStorage.getItem('prepro-pref-' + k); return v === null ? undefined : JSON.parse(v); },
    setPref(k, v) { localStorage.setItem('prepro-pref-' + k, JSON.stringify(v)); },
    saveAI(cfg) { cfg ? localStorage.setItem('prepro-ai', JSON.stringify(cfg)) : localStorage.removeItem('prepro-ai'); },
  };
})();
