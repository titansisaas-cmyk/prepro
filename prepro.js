/* PrePro extensions: song saving (browser library + .prepro files), clip tools,
   built-in part synthesizer, and a bring-your-own-account AI assistant. */
'use strict';

// ───────────────────────── Project serialization ─────────────────────────
S.songId = null;
const MAGIC = 'PREPRO01';

function projectJSON() {
  const used = new Set();
  S.tracks.forEach(t => { t.clips.forEach(c => c.bufId && used.add(c.bufId)); Object.values(t.inst?.samples || {}).forEach(id => used.add(id)); [...(t.playlists || [])].forEach(p => p.clips.forEach(c => c.bufId && used.add(c.bufId))); });
  return {
    format: 'prepro', version: 1, name: S.name, tempo: S.tempo, gridBeats: S.gridBeats, pps: S.pps,
    master: S.master, markers: S.markers,
    tracks: S.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c })) })),
    buffers: [...used].filter(id => buffers.has(id)).map(id => { const b = buffers.get(id); return { id, name: b.name, sr: b.buffer.sampleRate, ch: b.buffer.numberOfChannels, len: b.buffer.length }; }),
    savedAt: new Date().toISOString(),
  };
}
// Binary layout: "PREPRO01" | uint32 jsonLen | json utf8 | float32 audio (per buffer, per channel)
function encodeProject() {
  const meta = projectJSON();
  const json = new TextEncoder().encode(JSON.stringify(meta));
  let audioBytes = 0;
  meta.buffers.forEach(b => { audioBytes += b.len * b.ch * 4; });
  const pad = (4 - ((12 + json.length) % 4)) % 4;
  const out = new ArrayBuffer(12 + json.length + pad + audioBytes);
  const u8 = new Uint8Array(out), dv = new DataView(out);
  for (let i = 0; i < 8; i++) u8[i] = MAGIC.charCodeAt(i);
  dv.setUint32(8, json.length + pad, true);
  u8.set(json, 12);
  for (let i = 0; i < pad; i++) u8[12 + json.length + i] = 32; // spaces keep JSON valid
  let o = 12 + json.length + pad;
  for (const b of meta.buffers) {
    const buf = buffers.get(b.id).buffer;
    for (let c = 0; c < b.ch; c++) { new Float32Array(out, o, b.len).set(buf.getChannelData(c)); o += b.len * 4; }
  }
  return { bytes: out, meta };
}
function decodeProject(ab) {
  const u8 = new Uint8Array(ab);
  const magic = String.fromCharCode(...u8.slice(0, 8));
  if (magic !== MAGIC) throw new Error('This is not a PrePro song file');
  const jl = new DataView(ab).getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(u8.slice(12, 12 + jl)));
  let o = 12 + jl;
  const bufs = new Map();
  for (const b of meta.buffers) {
    const ab2 = ctx.createBuffer(b.ch, b.len, b.sr);
    for (let c = 0; c < b.ch; c++) { ab2.getChannelData(c).set(new Float32Array(ab.slice(o, o + b.len * 4))); o += b.len * 4; }
    bufs.set(b.id, { buffer: ab2, name: b.name });
  }
  return { meta, bufs };
}
function loadProject({ meta, bufs }, songId = null) {
  stop();
  for (const t of S.tracks) destroyLiveChain(t.id);
  buffers.clear();
  for (const [id, b] of bufs) buffers.set(id, { buffer: b.buffer, peaks: computePeaks(b.buffer), name: b.name });
  S.name = meta.name || 'Untitled Song'; S.tempo = meta.tempo || 120; S.gridBeats = meta.gridBeats || 1;
  S.markers = meta.markers || [];
  S.tracks = meta.tracks || [];
  Object.assign(S.master, meta.master || {});
  S.tracks.forEach(t => { if (t.vol === null) t.vol = -Infinity; t.inserts = t.inserts || [null, null, null, null, null]; createLiveChain(t); });
  if (S.master.vol === null) S.master.vol = -Infinity;
  rewire(S.master); masterChain.plugins.forEach((p, i) => { if (p && p.set && S.master.inserts[i]) p.set(S.master.inserts[i].params); }); applyMix(S.master);
  // keep new ids unique
  let max = 0;
  const scan = s => { const m = String(s).match(/(\d+)$/); if (m) max = Math.max(max, +m[1]); };
  S.tracks.forEach(t => { scan(t.id); t.clips.forEach(c => scan(c.id)); });
  bufs.forEach((_, id) => scan(id)); S.markers.forEach(m => scan(m.id));
  _uid = max + 1; trackCounter = S.tracks.length;
  S.sel = { start: 0, end: 0, tracks: new Set() }; S.selClips.clear(); S.scrollT = 0;
  history.undo = []; history.redo = [];
  S.songId = songId;
  $('#tempoIn').value = S.tempo; $('#gridSel').value = String(S.gridBeats);
  $('#sessionName').textContent = S.name;
  refreshAll(); zoomFit();
}

// ───────────────────────── Browser song library (IndexedDB) ─────────────────────────
// storage.js (standalone build) provides a persistent IndexedDB store; otherwise songs live in memory for this session
const MemStore = { m: new Map(), persistent: false,
  async open() { return true; }, async put(r) { this.m.set(r.id, r); }, async get(id) { return this.m.get(id); }, async del(id) { this.m.delete(id); },
  async list() { return [...this.m.values()].map(({ id, name, updated, size, tracks }) => ({ id, name, updated, size, tracks })).sort((a, b) => b.updated - a.updated); } };
const Lib = {
  ok: null, s: null,
  async open() {
    if (this.ok !== null) return this.ok;
    this.s = window.PREPRO_STORE && (await window.PREPRO_STORE.open().catch(() => false)) ? window.PREPRO_STORE : MemStore;
    return (this.ok = true);
  },
  get persistent() { return !!this.s?.persistent; },
  put(r) { return this.s.put(r); }, get(id) { return this.s.get(id); }, del(id) { return this.s.del(id); }, list() { return this.s.list(); },
};
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

async function saveSong(asNew = false, silent = false) {
  if (!(await Lib.open())) {
    if (silent) return;
    openModal('Save Song', '<p>This browser view does not allow PrePro to keep songs in its library (private or embedded windows block browser storage). Save the song as a .prepro file instead. You can open it again any time with File > Open Song File.</p>',
      [{ label: 'Cancel' }, { label: 'Save as .prepro file', primary: true, action: () => { downloadProject(); } }]);
    return;
  }
  if (!S.songId || asNew) {
    if (silent) return;
    return openModal(asNew ? 'Save Song As' : 'Save Song', `<div class="row" style="grid-template-columns:90px 1fr"><label>Song name</label><input type="text" id="svName" value="${escapeHtml(S.name === 'Demo Session' || S.name === 'Untitled Session' ? 'My Song' : S.name)}" maxlength="60"></div>`,
      [{ label: 'Cancel' }, { label: 'Save', primary: true, action: () => { S.name = $('#svName').value.trim() || 'My Song'; $('#sessionName').textContent = S.name; S.songId = uid('song') + '-' + Date.now(); writeSong(); } }]);
  }
  return writeSong(silent);
}
async function writeSong(silent) {
  try {
    const { bytes } = encodeProject();
    await Lib.put({ id: S.songId, name: S.name, updated: Date.now(), size: bytes.byteLength, tracks: S.tracks.length, data: bytes });
    lastSavedSnap = snapshot() + S.tracks.map(t => t.vol + ',' + t.pan).join();
    status((silent ? 'Auto-saved "' : 'Saved "') + S.name + '"');
  } catch (e) { status('Save failed: ' + e.message); }
}
async function openSongDialog() {
  const ok = await Lib.open();
  let rows = '';
  if (ok) {
    const songs = await Lib.list();
    rows = songs.length ? `<div class="song-list">${songs.map(s => `<div class="song-row"><div><b>${escapeHtml(s.name)}</b><small>${new Date(s.updated).toLocaleString()} · ${s.tracks} tracks · ${fmtSize(s.size)}</small></div><button data-del="${s.id}">Delete</button><button class="primary" data-open="${s.id}">Open</button></div>`).join('')}</div>`
      : '<p>No saved songs yet. Use File > Save Song (Ctrl+S) to add one.</p>';
  } else rows = '<p>Browser storage is blocked in this view, so the song library is unavailable. You can still open a .prepro song file.</p>';
  if (!Lib.persistent) rows = '<p class="hint" style="color:var(--text-dim);margin-bottom:8px">In this preview, songs are kept for this session only. Use File > Save Song File (.prepro) to keep a copy, or open PrePro in its own tab to get the permanent song library.</p>' + rows;
  const m = openModal('Open Song', `<div class="wide">${rows}</div>`, [{ label: 'Open .prepro file…', action: () => { $('#songFileIn').click(); } }, { label: 'Close', primary: true }]);
  m.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
    const rec = await Lib.get(b.dataset.open);
    $('#modalBack').hidden = true;
    try { loadProject(decodeProject(rec.data), rec.id); status('Opened "' + rec.name + '"'); } catch (e) { status('Could not open song: ' + e.message); }
  });
  m.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (b.dataset.confirm) { await Lib.del(b.dataset.del); if (S.songId === b.dataset.del) S.songId = null; b.closest('.song-row').remove(); status('Song deleted'); }
    else { b.dataset.confirm = '1'; b.textContent = 'Confirm'; b.style.background = '#a33029'; }
  });
}
function downloadProject() {
  const { bytes } = encodeProject();
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const fname = (S.name || 'Song').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.prepro';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  status('Saved ' + fname + ' (' + fmtSize(blob.size) + ')');
}
const songFileIn = document.createElement('input');
songFileIn.type = 'file'; songFileIn.accept = '.prepro'; songFileIn.id = 'songFileIn'; songFileIn.hidden = true;
document.body.appendChild(songFileIn);
songFileIn.addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  $('#modalBack').hidden = true;
  try { loadProject(decodeProject(await f.arrayBuffer())); status('Opened ' + f.name); } catch (err) { status('Could not open file: ' + err.message); }
});

// autosave every 45 s for songs already saved in the library
let lastSavedSnap = '';
setInterval(() => {
  if (!S.songId || T.playing || drag) return;
  const snap = snapshot() + S.tracks.map(t => t.vol + ',' + t.pan).join();
  if (snap !== lastSavedSnap) saveSong(false, true);
}, 45000);

// File menu items
window.PREPRO_FILE_ITEMS = () => [
  { sep: true },
  { label: 'Save Song', k: K('Mod+S'), action: () => saveSong() },
  { label: 'Save Song As…', action: () => saveSong(true) },
  { label: 'Open Song…', k: K('Mod+O'), action: openSongDialog },
  { sep: true },
  { label: 'Save Song File (.prepro)…', action: downloadProject },
  { label: 'Open Song File…', action: () => songFileIn.click() },
];
const _newSession = newSession;
newSession = function (demo) { _newSession(demo); S.songId = null; };

// ───────────────────────── Clip tools (Normalize / Reverse) ─────────────────────────
function processClips(fn, label) {
  const ids = [...S.selClips];
  if (!ids.length) return status('Select clips with the Grabber first');
  pushHistory();
  for (const id of ids) {
    const f = findClip(id); if (!f || f.c.type === 'midi') continue;
    const src = buffers.get(f.c.bufId).buffer, sr = src.sampleRate;
    const s0 = Math.floor(f.c.offset * sr), n = Math.max(1, Math.floor(f.c.dur * sr));
    const out = ctx.createBuffer(src.numberOfChannels, n, sr);
    const chans = [];
    for (let c = 0; c < src.numberOfChannels; c++) { const d = out.getChannelData(c); d.set(src.getChannelData(c).subarray(s0, s0 + n)); chans.push(d); }
    fn(chans);
    f.c.bufId = addBuffer(out, f.c.name); f.c.offset = 0; f.c.dur = out.duration;
  }
  dirty(); status(label);
}
const normalizeClips = () => processClips(chs => { let m = 0; chs.forEach(d => { for (const v of d) m = Math.max(m, Math.abs(v)); }); const g = m ? dbToGain(-0.3) / m : 1; chs.forEach(d => { for (let i = 0; i < d.length; i++) d[i] *= g; }); }, 'Normalized to -0.3 dBFS');
const reverseClips = () => processClips(chs => chs.forEach(d => d.reverse()), 'Reversed');
const _clipMenu = MENUS.clip;
MENUS.clip = () => [..._clipMenu(), { sep: true }, { label: 'Normalize', action: normalizeClips }, { label: 'Reverse', action: reverseClips }];

// ───────────────────────── Part synthesizer (used by the AI) ─────────────────────────
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
function renderPart(part) {
  const sr = ctx.sampleRate, beat = 60 / S.tempo, bars = clamp(part.bars || 4, 1, 64);
  const len = Math.floor((bars * 4 * beat + 1.5) * sr);
  const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
  if (part.kind === 'drums') {
    for (const h of part.hits || []) {
      const t0 = Math.floor((+h.beat || 0) * beat * sr), v = clamp(h.vel ?? 0.9, 0.05, 1);
      if (t0 < 0 || t0 >= len) continue;
      const D = String(h.drum || 'kick').toLowerCase();
      const L = Math.min(len - t0, Math.floor(0.45 * sr));
      let ph = 0, prev = 0, lp = 0;
      for (let i = 0; i < L; i++) {
        const t = i / sr, n = Math.random() * 2 - 1;
        let s = 0;
        if (D.includes('kick')) { const f = 48 + 110 * Math.exp(-t * 32); ph += 2 * Math.PI * f / sr; s = Math.sin(ph) * Math.exp(-t * 7.5); }
        else if (D.includes('snare')) { lp += (n - lp) * 0.5; s = lp * Math.exp(-t * 16) * 0.6 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 28) * 0.4; }
        else if (D.includes('clap')) { const env = (t < 0.03 ? (Math.sin(t * 600) > 0 ? 1 : 0.3) : 1) * Math.exp(-t * 18); s = (n - prev) * env * 0.6; prev = n; }
        else if (D.includes('open')) { s = (n - prev) * Math.exp(-t * 12) * 0.22; prev = n; }
        else if (D.includes('hat')) { s = (n - prev) * Math.exp(-t * 70) * 0.25; prev = n; }
        else if (D.includes('tom')) { const f = 90 + 60 * Math.exp(-t * 20); ph += 2 * Math.PI * f / sr; s = Math.sin(ph) * Math.exp(-t * 9) * 0.8; }
        else if (D.includes('rim') || D.includes('perc')) { s = Math.sin(2 * Math.PI * 820 * t) * Math.exp(-t * 60) * 0.6; }
        else if (D.includes('crash') || D.includes('ride')) { s = (n - prev) * Math.exp(-t * 4) * 0.18; prev = n; }
        d[t0 + i] += s * v;
      }
    }
  } else {
    const sound = String(part.sound || (part.kind === 'bass' ? 'bass' : part.kind === 'chords' ? 'pad' : 'lead')).toLowerCase();
    for (const nt of part.notes || []) {
      const s0 = Math.floor((+nt.beat || 0) * beat * sr);
      const L = Math.floor(Math.max(0.05, (+nt.len || 1) * beat) * sr);
      if (s0 < 0 || s0 >= len) continue;
      const f = midiHz(clamp(+nt.midi || 60, 20, 110)), v = clamp(nt.vel ?? 0.8, 0.05, 1);
      const rel = Math.floor((sound === 'pad' ? 0.35 : 0.06) * sr);
      let ph = 0, lp = 0, lp2 = 0;
      // Karplus-Strong buffer for plucks
      const ksN = Math.max(2, Math.round(sr / f)), ks = sound === 'pluck' ? Float32Array.from({ length: ksN }, () => Math.random() * 2 - 1) : null;
      for (let i = 0; i < L + rel && s0 + i < len; i++) {
        const t = i / sr;
        const gate = i < L ? 1 : 1 - (i - L) / rel;
        let s = 0;
        if (sound === 'bass' || sound === 'saw' || sound === 'synthbass') {
          ph = (ph + f / sr) % 1; const saw = 2 * ph - 1;
          const fc = 220 + 1500 * Math.exp(-t * 12), a = 1 - Math.exp(-2 * Math.PI * fc / sr);
          lp += (saw - lp) * a; lp2 += (lp - lp2) * a; s = lp2 * (0.7 + 0.3 * Math.exp(-t * 4));
        } else if (sound === 'sub' || sound === 'sine') { ph += 2 * Math.PI * f / sr; s = Math.sin(ph) * Math.min(1, t / 0.005); }
        else if (sound === 'pad' || sound === 'strings') {
          const tri = x => 2 / Math.PI * Math.asin(Math.sin(x));
          s = (tri(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 1.004 * t) * 0.35 + Math.sin(2 * Math.PI * f * 0.996 * t) * 0.35) * Math.min(1, t / 0.25) * 0.5;
        } else if (sound === 'pluck') { const k = i % ksN; const nx = (k + 1) % ksN; ks[k] = (ks[k] + ks[nx]) * 0.4985; s = ks[k] * 0.9; }
        else if (sound === 'keys' || sound === 'piano' || sound === 'ep') {
          s = (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 3) + 0.15 * Math.sin(6 * Math.PI * f * t) * Math.exp(-t * 6)) * Math.exp(-t * 1.6) * Math.min(1, t / 0.004) * 0.6;
        } else { // lead / square
          const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3); ph += 2 * Math.PI * f * vib / sr;
          s = (Math.sin(ph) + 0.32 * Math.sin(3 * ph) + 0.16 * Math.sin(5 * ph) + 0.08 * Math.sin(7 * ph)) * Math.min(1, t / 0.012) * (0.75 + 0.25 * Math.exp(-t * 5)) * 0.45;
        }
        d[s0 + i] += s * v * gate;
      }
    }
  }
  let m = 0; for (const x of d) m = Math.max(m, Math.abs(x));
  if (m > 0) { const g = 0.8 / m; for (let i = 0; i < d.length; i++) d[i] *= g; }
  // trim trailing silence
  let end = d.length - 1; while (end > 0 && Math.abs(d[end]) < 1e-4) end--;
  const n = Math.max(Math.floor(bars * 4 * beat * sr), end + 1);
  if (n < len) { const b2 = ctx.createBuffer(1, n, sr); b2.getChannelData(0).set(d.subarray(0, n)); return b2; }
  return buf;
}

// ───────────────────────── AI: settings & providers ─────────────────────────
const AI_PROVIDERS = {
  openai: { label: 'OpenAI', model: 'gpt-5-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-sonnet-4-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Google Gemini', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  compatible: { label: 'OpenAI-compatible (OpenRouter, Groq, Ollama…)', model: '', keyUrl: 'https://openrouter.ai/keys', base: 'https://openrouter.ai/api/v1' },
};
const AIcfg = { provider: 'openai', key: '', model: '', base: '', remember: false };
try { const s = window.PREPRO_STORE?.loadAI(); if (s) Object.assign(AIcfg, s, { remember: true }); } catch (e) {}
const aiConnected = () => !!AIcfg.key;
function persistAI() {
  try { window.PREPRO_STORE?.saveAI(AIcfg.remember ? AIcfg : null); } catch (e) {}
}

async function aiCall(system, messages, { json = true, maxTokens = 2500 } = {}) {
  const p = AIcfg.provider, key = AIcfg.key, model = AIcfg.model || AI_PROVIDERS[p].model;
  let res, data;
  const fail = async r => { let t = ''; try { const j = await r.json(); t = j.error?.message || j.error?.type || JSON.stringify(j).slice(0, 200); } catch (e) { t = r.statusText; } throw new Error(`${AI_PROVIDERS[p].label} returned ${r.status}: ${t}`); };
  if (p === 'anthropic') {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
    if (!res.ok) await fail(res);
    data = await res.json();
    return (data.content || []).map(c => c.text || '').join('');
  }
  if (p === 'gemini') {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: json ? { responseMimeType: 'application/json' } : {},
      }),
    });
    if (!res.ok) await fail(res);
    data = await res.json();
    return (data.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  }
  const base = p === 'compatible' ? (AIcfg.base || AI_PROVIDERS.compatible.base).replace(/\/$/, '') : 'https://api.openai.com/v1';
  const body = { model, messages: [{ role: 'system', content: system }, ...messages] };
  if (json) body.response_format = { type: 'json_object' };
  res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
  if (!res.ok && json && res.status === 400) { delete body.response_format; res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body) }); }
  if (!res.ok) await fail(res);
  data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}
async function aiListModels() {
  const p = AIcfg.provider, key = AIcfg.key;
  let r;
  if (p === 'anthropic') r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
  else if (p === 'gemini') r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  else r = await fetch((p === 'compatible' ? (AIcfg.base || AI_PROVIDERS.compatible.base).replace(/\/$/, '') : 'https://api.openai.com/v1') + '/models', { headers: { authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error('Could not list models (' + r.status + '). Check the key.');
  const j = await r.json();
  if (p === 'gemini') return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace('models/', ''));
  return (j.data || []).map(m => m.id).filter(id => p !== 'openai' || /^(gpt|o\d|chatgpt)/.test(id)).sort();
}

function aiSettingsDialog() {
  const m = openModal('Connect your AI account', `<div class="wide">
    <p style="margin-bottom:12px">PrePro AI runs on <b>your own</b> AI provider account. Requests go straight from this browser to the provider you pick, and usage is billed by that provider to you. PrePro never stores your key on a server.</p>
    <div class="ai-form-grid">
      <label>Provider</label><select id="aiProv">${Object.entries(AI_PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === AIcfg.provider ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <label id="aiBaseL">API base URL</label><input type="text" id="aiBase" placeholder="https://openrouter.ai/api/v1" value="${escapeHtml(AIcfg.base || '')}">
      <label>API key</label><input type="password" id="aiKey" placeholder="Paste your API key" value="${escapeHtml(AIcfg.key)}" autocomplete="off">
      <label>Model</label><div style="display:flex;gap:6px"><input type="text" id="aiModel" list="aiModelList" value="${escapeHtml(AIcfg.model)}" placeholder=""><datalist id="aiModelList"></datalist><button id="aiLoadModels" style="background:#3a3e43;border:1px solid #111;border-radius:3px;padding:0 8px;white-space:nowrap">List models</button></div>
      <span></span><label style="display:flex;gap:6px;align-items:center;color:var(--text-dim)"><input type="checkbox" id="aiRemember" ${AIcfg.remember ? 'checked' : ''} ${window.PREPRO_STORE ? '' : 'disabled'}> ${window.PREPRO_STORE ? 'Remember on this device' : 'Key is kept for this session only in the preview'}</label>
    </div>
    <p id="aiGetKey" style="margin-top:12px"></p>
    <p id="aiTestOut" style="margin-top:6px"></p></div>`,
    [{ label: 'Disconnect', action: () => { AIcfg.key = ''; AIcfg.remember = false; persistAI(); aiRefresh(); } },
     { label: 'Test connection', action: () => { readForm(); testAI(); return false; } },
     { label: 'Save', primary: true, action: () => { readForm(); persistAI(); aiRefresh(); if (aiConnected()) aiSys('Account saved: ' + AI_PROVIDERS[AIcfg.provider].label + ', model ' + (AIcfg.model || AI_PROVIDERS[AIcfg.provider].model) + '. Use Test connection in Account if replies fail.'); } }]);
  const sync = () => {
    const p = $('#aiProv').value, info = AI_PROVIDERS[p];
    $('#aiModel').placeholder = info.model || 'e.g. meta-llama/llama-3.3-70b-instruct';
    $('#aiBase').style.display = $('#aiBaseL').style.display = p === 'compatible' ? '' : 'none';
    $('#aiGetKey').innerHTML = `No key yet? Create one at <a href="${info.keyUrl}" target="_blank" rel="noopener" style="color:#b6a4ff">${info.keyUrl.replace('https://', '')}</a>, then paste it above.`;
  };
  const readForm = () => { AIcfg.provider = $('#aiProv').value; AIcfg.key = $('#aiKey').value.trim(); AIcfg.model = $('#aiModel').value.trim(); AIcfg.base = $('#aiBase').value.trim(); AIcfg.remember = $('#aiRemember').checked; };
  const testAI = async () => {
    const out = $('#aiTestOut'); out.style.color = 'var(--text-dim)'; out.textContent = 'Testing…';
    try { const t = await aiCall('Reply with the JSON {"ok":true}.', [{ role: 'user', content: 'ping' }], { maxTokens: 50 }); out.style.color = '#7fe0a8'; out.textContent = 'Connected. The provider replied: ' + t.slice(0, 80); }
    catch (e) { out.style.color = '#ff8a80'; out.textContent = e.message; }
  };
  $('#aiProv').onchange = () => { $('#aiModel').value = ''; sync(); };
  $('#aiLoadModels').onclick = async e => {
    e.preventDefault(); readForm();
    const out = $('#aiTestOut'); out.style.color = 'var(--text-dim)'; out.textContent = 'Loading models…';
    try { const list = await aiListModels(); $('#aiModelList').innerHTML = list.map(x => `<option value="${escapeHtml(x)}">`).join(''); out.textContent = list.length + ' models available. Click the Model box to choose one.'; }
    catch (err) { out.style.color = '#ff8a80'; out.textContent = err.message; }
  };
  sync();
}

// ───────────────────────── AI: session context & actions ─────────────────────────
const statCache = new Map();
function bufStats(id) {
  if (statCache.has(id)) return statCache.get(id);
  const b = buffers.get(id).buffer, d = b.getChannelData(0);
  let pk = 0, sum = 0, zc = 0; const step = Math.max(1, Math.floor(d.length / 200000));
  let n = 0, prev = 0;
  for (let i = 0; i < d.length; i += step) { const v = d[i]; pk = Math.max(pk, Math.abs(v)); sum += v * v; n++; if ((v >= 0) !== (prev >= 0)) zc++; prev = v; }
  const st = { peakDb: +gainToDb(pk).toFixed(1), rmsDb: +gainToDb(Math.sqrt(sum / n)).toFixed(1), brightness: +((zc / n) * b.sampleRate / step / 2).toFixed(0) };
  statCache.set(id, st);
  return st;
}
const toBar = t => +(t / beatSec() / 4 + 1).toFixed(2);
function sessionContext() {
  return {
    song: S.name, tempo: S.tempo, timeSignature: '4/4', lengthBars: +(sessionEnd() / beatSec() / 4).toFixed(2),
    selection: S.sel.end - S.sel.start > 0.01 ? { startBar: toBar(S.sel.start), endBar: toBar(S.sel.end), tracks: selectedTracks().map(t => t.name) } : null,
    master: { volumeDb: S.master.vol, inserts: S.master.inserts.map((x, i) => x && { slot: i, plugin: x.type, bypass: x.bypass, params: x.params }).filter(Boolean) },
    tracks: S.tracks.map(t => ({
      name: t.name, volumeDb: t.vol === -Infinity ? -90 : t.vol, pan: t.pan, mute: t.mute, solo: t.solo,
      inserts: t.inserts.map((x, i) => x && { slot: i, plugin: x.type, bypass: x.bypass, params: x.params }).filter(Boolean),
      type: t.kind === 'inst' ? 'midi-' + t.inst.type : 'audio',
      clips: t.clips.slice(0, 20).map(c => ({ name: c.name, startBar: toBar(c.start), lengthBars: +(c.dur / beatSec() / 4).toFixed(2), ...(c.type === 'midi' ? { midiNotes: c.notes.length } : bufStats(c.bufId)) })),
    })),
    markers: S.markers.map(m => ({ name: m.name, bar: toBar(m.t) })),
  };
}
const AI_SYSTEM = () => `You are PrePro AI, an expert music producer and mix engineer built into the PrePro digital audio workstation.
You see the current session as JSON and can change it by returning actions. Always answer with ONE JSON object only:
{"reply": "short helpful answer in plain language (max ~120 words)", "actions": [ ... ]}

Available actions (use exact track names from the session; bars and beats are 1-based for bars, beats are quarter notes counted from 0 within a part):
- {"type":"set_volume","track":"Drums","db":-6}            // -60..+12
- {"type":"set_pan","track":"Keys","pan":-0.3}               // -1 left .. 1 right
- {"type":"mute","track":"Bass","on":true} / {"type":"solo","track":"Lead","on":true}
- {"type":"add_insert","track":"Drums","plugin":"comp","params":{...}}   // plugin: eq|filter|comp|delay|reverb|trim
- {"type":"set_insert","track":"Drums","slot":0,"params":{...}}          // change params of an existing insert slot (0-4)
- {"type":"remove_insert","track":"Drums","slot":1}
- {"type":"bypass_insert","track":"Drums","slot":1,"on":true}
- {"type":"master_volume","db":-1}
- {"type":"set_tempo","bpm":96}
- {"type":"add_marker","bar":9,"name":"Chorus"}
- {"type":"rename_track","track":"Audio 1","name":"Vocals"}
- {"type":"new_track","name":"Vox"}
- {"type":"delete_track","track":"Lead"}
- {"type":"move_clip","track":"Lead","clip":"Lead_01","toBar":5}
- {"type":"select","startBar":1,"endBar":5,"tracks":["Drums"]}
- {"type":"loop","startBar":1,"endBar":5}
- {"type":"play"} / {"type":"stop"}
- {"type":"generate_part","name":"Bass 2","kind":"bass|drums|chords|melody","sound":"bass|sub|pad|keys|pluck|lead","startBar":1,"bars":8,
   "notes":[{"beat":0,"len":0.5,"midi":45,"vel":0.9}, ...],         // for pitched parts; beat 0 = first beat of startBar
   "hits":[{"beat":0,"drum":"kick","vel":1}, ...],                     // for drums: kick|snare|clap|hat|openhat|pedal|tom1|tom2|tom3|rim|crash|ride|bell (General MIDI / TD-17 map)
   "inserts":[{"plugin":"reverb","params":{"mix":20}}], "volumeDb":-8, "pan":0}
Plug-in params: eq {low,lowF,mid,midF,q,high,highF} (dB/Hz); filter {type:lowpass|highpass|bandpass,freq,q}; comp {threshold(dB),ratio,knee,attack(ms),release(ms),makeup(dB)}; delay {time(ms),feedback(%),tone(Hz),mix(%)}; reverb {decay(s),predelay(ms),tone(Hz),mix(%)}; trim {gain(dB),phase:"off"|"on"}.
Clip stats: peakDb, rmsDb (loudness), brightness (approx Hz, higher = brighter).
Parts are written as editable MIDI on instrument tracks (PrePro Drums or PrePro Synth). Tracks with type midi-* contain MIDI clips.\nRules: Only use actions when the user wants changes; for questions, return "actions": []. When writing parts, fit the session key/chords if known (the demo is A minor: Am F C G, one chord per bar) and the tempo. Write complete note lists for the requested bars (no placeholders). Keep the mix safe: avoid master clipping. Never invent track names that do not exist except for new tracks.`;

const findTrack = name => {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return S.tracks.find(t => t.name.toLowerCase() === n) || S.tracks.find(t => t.name.toLowerCase().includes(n) || n.includes(t.name.toLowerCase()));
};
const barToT = b => (Math.max(1, +b || 1) - 1) * 4 * beatSec();
function sanitizeParams(type, params) {
  const out = { ...defaultParams(type) };
  for (const p of PLUGINS[type].params) {
    const v = params?.[p.k];
    if (v === undefined) continue;
    if (p.options) { if (p.options.includes(v)) out[p.k] = v; }
    else if (isFinite(+v)) out[p.k] = clamp(+v, p.min, p.max);
  }
  return out;
}
function applyActions(actions) {
  const results = [];
  if (!Array.isArray(actions) || !actions.length) return results;
  pushHistory();
  let mixChanged = false, structChanged = false, transport = null;
  for (const a of actions) {
    let ok = true, label = '';
    try {
      const tr = a.track ? findTrack(a.track) : null;
      const need = () => { if (!tr) throw new Error('no track named "' + a.track + '"'); };
      switch (a.type) {
        case 'set_volume': need(); tr.vol = clamp(+a.db, -60, 12); applyMix(tr); label = `${tr.name} volume → ${fmtDb(tr.vol)} dB`; mixChanged = true; break;
        case 'set_pan': need(); tr.pan = clamp(+a.pan, -1, 1); applyMix(tr); label = `${tr.name} pan → ${panLabel(tr.pan)}`; mixChanged = true; break;
        case 'mute': need(); tr.mute = a.on !== false; applyAllMix(); label = `${tr.name} ${tr.mute ? 'muted' : 'unmuted'}`; mixChanged = true; break;
        case 'solo': need(); tr.solo = a.on !== false; applyAllMix(); label = `${tr.name} ${tr.solo ? 'soloed' : 'unsoloed'}`; mixChanged = true; break;
        case 'add_insert': {
          const obj = a.track === 'Master' || a.track === 'master' ? S.master : (need(), tr);
          if (!PLUGINS[a.plugin]) throw new Error('unknown plug-in ' + a.plugin);
          const slot = obj.inserts.findIndex(x => !x); if (slot < 0) throw new Error('no free insert slot');
          obj.inserts[slot] = { type: a.plugin, bypass: false, params: sanitizeParams(a.plugin, a.params) };
          rewire(obj); label = `${obj.name}: added ${PLUGINS[a.plugin].name} (insert ${'ABCDE'[slot]})`; mixChanged = true; break;
        }
        case 'set_insert': {
          const obj = a.track === 'Master' || a.track === 'master' ? S.master : (need(), tr);
          const ins = obj.inserts[+a.slot]; if (!ins) throw new Error('insert slot ' + a.slot + ' is empty');
          ins.params = sanitizeParams(ins.type, { ...ins.params, ...a.params });
          rewire(obj); const ch = obj.id === 'master' ? masterChain : live.get(obj.id); ch.plugins[+a.slot]?.set(ins.params);
          label = `${obj.name}: adjusted ${PLUGINS[ins.type].name}`; mixChanged = true; break;
        }
        case 'remove_insert': { need(); if (!tr.inserts[+a.slot]) throw new Error('slot empty'); const n = PLUGINS[tr.inserts[+a.slot].type].name; tr.inserts[+a.slot] = null; rewire(tr); label = `${tr.name}: removed ${n}`; mixChanged = true; break; }
        case 'bypass_insert': { need(); const ins = tr.inserts[+a.slot]; if (!ins) throw new Error('slot empty'); ins.bypass = a.on !== false; rewire(tr); label = `${tr.name}: ${ins.bypass ? 'bypassed' : 'enabled'} ${PLUGINS[ins.type].name}`; mixChanged = true; break; }
        case 'master_volume': S.master.vol = clamp(+a.db, -60, 12); applyMix(S.master); label = `Master → ${fmtDb(S.master.vol)} dB`; mixChanged = true; break;
        case 'set_tempo': setTempo(clamp(+a.bpm, 40, 240)); label = `Tempo → ${S.tempo} BPM`; break;
        case 'add_marker': S.markers.push({ id: uid('mk'), t: barToT(a.bar), name: String(a.name || 'Marker').slice(0, 30) }); S.markers.sort((x, y) => x.t - y.t); label = `Marker "${a.name}" at bar ${a.bar}`; break;
        case 'rename_track': need(); { const old = tr.name; tr.name = String(a.name).slice(0, 32); label = `Renamed ${old} → ${tr.name}`; } structChanged = true; break;
        case 'new_track': { const t = newTrack(String(a.name || '').slice(0, 32) || undefined); label = `New track ${t.name}`; structChanged = true; break; }
        case 'delete_track': need(); destroyLiveChain(tr.id); S.tracks = S.tracks.filter(x => x !== tr); label = `Deleted track ${tr.name}`; structChanged = true; break;
        case 'move_clip': { need(); const c = tr.clips.find(c => c.name === a.clip) || tr.clips[0]; if (!c) throw new Error('no clip'); c.start = barToT(a.toBar); sortClips(tr); carveUnder(tr, c); label = `Moved ${c.name} to bar ${a.toBar}`; break; }
        case 'select': case 'loop': {
          S.sel.start = barToT(a.startBar); S.sel.end = barToT(a.endBar);
          S.sel.tracks = new Set((a.tracks ? a.tracks.map(findTrack).filter(Boolean) : S.tracks).map(t => t.id));
          if (a.type === 'loop') { S.loop = true; updateTransportUI(); }
          label = `${a.type === 'loop' ? 'Loop' : 'Selection'} bars ${a.startBar}–${a.endBar}`; break;
        }
        case 'play': transport = 'play'; label = 'Play'; break;
        case 'stop': transport = 'stop'; label = 'Stop'; break;
        case 'generate_part': {
          const kind = String(a.kind || 'melody').toLowerCase();
          const bars = clamp(+a.bars || 4, 1, 64);
          const evts = kind === 'drums' ? (a.hits || []) : (a.notes || []);
          if (!evts.length) throw new Error('the part had no notes');
          const name = String(a.name || (kind[0].toUpperCase() + kind.slice(1))).slice(0, 28);
          const spb = beatSec(), dur = bars * 4 * spb;
          const DN = { kick: 36, bd: 36, snare: 38, sd: 38, rim: 37, xstick: 37, clap: 39, hat: 42, hihat: 42, closedhat: 42, openhat: 46, pedal: 44, tom: 45, tom1: 48, tom2: 45, tom3: 43, floortom: 43, crash: 49, ride: 51, bell: 53, cowbell: 56 };
          const notes = kind === 'drums'
            ? a.hits.map(h => { const key = String(h.drum || 'kick').toLowerCase().replace(/[^a-z0-9]/g, ''); const nn = isFinite(+h.midi) ? +h.midi : (DN[key] ?? (key.includes('open') ? 46 : key.includes('hat') ? 42 : key.includes('snare') ? 38 : key.includes('tom') ? 45 : key.includes('crash') ? 49 : 36)); return { t: Math.max(0, +h.beat || 0) * spb, d: 0.1, n: nn, v: clamp(Math.round((h.vel ?? 0.85) * 127), 1, 127) }; })
            : a.notes.map(n => ({ t: Math.max(0, +n.beat || 0) * spb, d: Math.max(0.05, (+n.len || 1) * spb), n: clamp(Math.round(+n.midi || 60), 0, 127), v: clamp(Math.round((n.vel ?? 0.8) * 127), 1, 127) }));
          const existing = findTrack(a.name);
          const preset = ({ bass: 'bass', synthbass: 'bass', saw: 'bass', sub: 'sub', sine: 'sub', pad: 'pad', strings: 'strings', keys: 'keys', piano: 'keys', ep: 'keys', pluck: 'pluck', lead: 'lead', square: 'lead' })[String(a.sound || '').toLowerCase()] || (kind === 'bass' ? 'bass' : kind === 'chords' ? 'pad' : 'lead');
          let t;
          if (existing && existing.kind === 'inst' && a.replace) t = existing;
          else { t = makeInstTrack(kind === 'drums' ? 'drums' : 'synth', name); if (isFinite(+a.volumeDb)) t.vol = clamp(+a.volumeDb, -40, 6); else t.vol = kind === 'drums' ? -6 : -8; if (isFinite(+a.pan)) t.pan = clamp(+a.pan, -1, 1); }
          if (kind !== 'drums') t.inst.preset = preset;
          (a.inserts || []).slice(0, 5).forEach((x, i) => { if (PLUGINS[x.plugin]) t.inserts[i] = { type: x.plugin, bypass: false, params: sanitizeParams(x.plugin, x.params) }; });
          rewire(t); applyMix(t);
          const st = barToT(a.startBar || 1);
          carveRange(t, st, st + dur);
          t.clips.push(newMidiClip(notes.filter(n => n.t < dur), st, dur, name.replace(/\s+/g, '_') + '_AI')); sortClips(t);
          label = `Wrote ${bars}-bar ${kind} MIDI part on "${t.name}" (${evts.length} ${kind === 'drums' ? 'hits' : 'notes'}, editable)`; structChanged = true; break;
        }
        default: throw new Error('unknown action ' + a.type);
      }
    } catch (e) { ok = false; label = (a.type || 'action') + ': ' + e.message; }
    results.push({ ok, label });
  }
  refreshAll();
  if (S.view === 'mix' || mixChanged) renderMixer();
  if (transport === 'play') play(); if (transport === 'stop') stop();
  return results;
}

// ───────────────────────── AI panel UI ─────────────────────────
const aiChat = [];
const aiPanel = $('#aiPanel'), aiMsgs = $('#aiMsgs');
function aiRefresh() {
  const st = $('#aiStatus');
  st.textContent = aiConnected() ? AI_PROVIDERS[AIcfg.provider].label.split(' (')[0] + ' · ' + (AIcfg.model || AI_PROVIDERS[AIcfg.provider].model) : 'Not connected';
  st.classList.toggle('ok', aiConnected());
  $('#aiSend').disabled = !aiConnected();
  const card = $('#aiConnectCard');
  if (!aiConnected() && !card) {
    const d = document.createElement('div'); d.className = 'ai-connect'; d.id = 'aiConnectCard';
    d.innerHTML = `<h4>Connect your own AI account</h4><p>PrePro AI uses your personal OpenAI, Anthropic (Claude), Google Gemini, or OpenAI-compatible account. Your key stays in this browser and requests go directly to your provider, so you control the cost.</p>
      <p>It can analyze your mix, adjust volume, pan and plug-ins, add markers and loops, and write new drum, bass, chord and melody parts straight onto tracks.</p>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="primary" id="aiConnectBtn">Connect account</button><a class="btn" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">Get an OpenAI key</a><a class="btn" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get a Gemini key</a></div>`;
    aiMsgs.prepend(d);
    d.querySelector('#aiConnectBtn').onclick = aiSettingsDialog;
  } else if (aiConnected() && card) card.remove();
}
function aiBubble(cls, html) { const d = document.createElement('div'); d.className = 'ai-msg ' + cls; d.innerHTML = html; aiMsgs.appendChild(d); aiMsgs.scrollTop = aiMsgs.scrollHeight; return d; }
const aiSys = t => aiBubble('sys', escapeHtml(t));
function parseAIJSON(txt) {
  try { return JSON.parse(txt); } catch (e) {}
  const m = txt.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return { reply: txt, actions: [] };
}
let aiBusy = false;
async function aiSend(text) {
  text = text.trim(); if (!text || aiBusy) return;
  if (!aiConnected()) { aiSettingsDialog(); return; }
  aiBusy = true; $('#aiSend').disabled = true;
  aiBubble('user', escapeHtml(text));
  const wait = aiBubble('bot', '<span class="typing"><i></i><i></i><i></i></span>');
  const userMsg = `Current session:\n${JSON.stringify(sessionContext())}\n\nRequest: ${text}`;
  const msgs = [...aiChat.slice(-8), { role: 'user', content: userMsg }];
  try {
    const raw = await aiCall(AI_SYSTEM(), msgs, { json: true, maxTokens: 6000 });
    const out = parseAIJSON(raw);
    aiChat.push({ role: 'user', content: text }, { role: 'assistant', content: JSON.stringify({ reply: out.reply, actions: (out.actions || []).map(a => a.type) }) });
    const acts = Array.isArray(out.actions) ? out.actions : [];
    wait.innerHTML = escapeHtml(out.reply || 'Done.');
    if (acts.length) {
      const box = document.createElement('div'); box.className = 'ai-actions'; wait.appendChild(box);
      const describe = a => a.type === 'generate_part' ? `Write ${a.bars || 4}-bar ${a.kind} part "${a.name || ''}"` : a.type.replace(/_/g, ' ') + (a.track ? ' · ' + a.track : '');
      const doApply = () => {
        const res = applyActions(acts);
        box.innerHTML = res.map(r => `<div class="act ${r.ok ? 'done' : 'fail'}">${escapeHtml(r.label)}</div>`).join('') + '<div class="row-btns"><button data-undo>Undo these changes</button></div>';
        box.querySelector('[data-undo]').onclick = e => { undo(); e.target.disabled = true; e.target.textContent = 'Undone'; renderMixer(); };
      };
      if ($('#aiAuto').checked) doApply();
      else {
        box.innerHTML = acts.map(a => `<div class="act">${escapeHtml(describe(a))}</div>`).join('') + '<div class="row-btns"><button class="primary" data-apply>Apply</button></div>';
        box.querySelector('[data-apply]').onclick = doApply;
      }
    }
  } catch (e) {
    wait.className = 'ai-msg err';
    wait.textContent = (e.message === 'Failed to fetch' ? 'Could not reach your AI provider. Check your internet connection and API base URL.' : e.message);
  }
  aiBusy = false; $('#aiSend').disabled = !aiConnected();
}
function toggleAI(force) {
  const show = force ?? aiPanel.hidden;
  aiPanel.hidden = !show; $('#btnAI').classList.toggle('active', show);
  if (show) { aiRefresh(); if (aiConnected()) setTimeout(() => $('#aiText').focus(), 30); }
}
$('#btnAI').onclick = () => toggleAI();
$('#aiClose').onclick = () => toggleAI(false);
$('#aiSettings').onclick = aiSettingsDialog;
$('#aiForm').addEventListener('submit', e => { e.preventDefault(); const t = $('#aiText').value; $('#aiText').value = ''; aiSend(t); });
$('#aiText').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aiForm').requestSubmit(); } });
$('#aiChips').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') aiSend(e.target.textContent); });
$('#btnSave').onclick = () => saveSong();
aiSys('Ask for mix advice, edits, or new parts. Every change can be undone with Ctrl+Z.');
aiRefresh();

// Menu + keyboard
MENUS.window = (orig => () => [...orig(), { sep: true }, { label: 'PrePro AI Assistant', k: K('Mod+I'), checked: !aiPanel.hidden, action: () => toggleAI() }, { label: 'AI Account…', action: aiSettingsDialog }])(MENUS.window);
window.addEventListener('keydown', e => {
  if (!$('#modalBack').hidden) return;
  if (e.target.matches('input, select, textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); saveSong(e.shiftKey); }
  else if (k === 'o') { e.preventDefault(); openSongDialog(); }
  else if (k === 'i' && !e.shiftKey) { e.preventDefault(); toggleAI(); }
});
