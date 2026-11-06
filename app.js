/* PrePro — a browser multitrack audio workstation modeled on the Pro Tools workflow.
   Web Audio engine, Edit + Mix windows, clip editing, recording, plug-ins and bounce. */
'use strict';

// ───────────────────────── Utilities ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let _uid = 1;
const uid = (p = 'id') => p + (_uid++);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dbToGain = db => (db <= -90 ? 0 : Math.pow(10, db / 20));
const gainToDb = g => (g <= 0.00003 ? -Infinity : 20 * Math.log10(g));
const clipLevel = c => (c.muted ? 0 : dbToGain(c.gain || 0));
const fmtDb = db => (db === -Infinity || db <= -90 ? '-∞' : (db > 0 ? '+' : '') + db.toFixed(1));
const COLORS = ['#5b8fd9', '#d9665b', '#62bf72', '#d9b25b', '#a77bd9', '#53c4c4', '#d97bb2', '#98a85a', '#d98b4a', '#7d8ad9'];

// fader position (0..1) <-> dB. Unity sits at ~0.73 of travel, +12 dB at top.
const faderToDb = p => (p <= 0.001 ? -Infinity : gainToDb(Math.pow(p, 3.2) * 3.98));
const dbToFader = db => (db === -Infinity || db <= -90 ? 0 : Math.pow(dbToGain(db) / 3.98, 1 / 3.2));

// ───────────────────────── Session state ─────────────────────────
const S = {
  name: 'Untitled Session',
  tempo: 120,
  tracks: [],
  master: { id: 'master', name: 'Master', vol: 0, pan: 0, inserts: [null, null, null, null, null] },
  markers: [],
  mode: 'slip',
  tool: 'smart',
  gridBeats: 1,
  pps: 46,            // pixels per second
  scrollT: 0,
  playhead: 0,
  sel: { start: 0, end: 0, tracks: new Set() },
  selClips: new Set(),
  loop: false, click: false, follow: true, insertionFollows: false,
  view: 'edit', showClipList: true,
};
const buffers = new Map();   // bufId -> { buffer, peaks, name }
const beatSec = () => 60 / S.tempo;
const gridSec = () => S.gridBeats * beatSec();
const snap = t => (S.mode === 'grid' ? Math.round(t / gridSec()) * gridSec() : t);
const sessionEnd = () => {
  let e = 0;
  for (const tr of S.tracks) for (const c of tr.clips) e = Math.max(e, c.start + c.dur);
  return e;
};
const trackById = id => S.tracks.find(t => t.id === id);
const findClip = id => { for (const tr of S.tracks) { const c = tr.clips.find(c => c.id === id); if (c) return { tr, c }; } return null; };

// Time formatting
function bbt(t, len = false) {
  const beats = Math.max(0, t) / beatSec();
  let bar = Math.floor(beats / 4), beat = Math.floor(beats % 4), tick = Math.floor((beats % 1) * 960 + 1e-6);
  if (!len) { bar += 1; beat += 1; }
  return String(bar).padStart(3, ' ') + '|' + String(beat).padStart(2, ' ') + '| ' + String(tick).padStart(3, '0');
}
function minsec(t, dec = 3) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + s.toFixed(dec).padStart(dec ? dec + 3 : 2, '0');
}

// ───────────────────────── History (undo/redo) ─────────────────────────
const history = { undo: [], redo: [] };
function snapshot() {
  return JSON.stringify({
    tracks: S.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c })) })),
    markers: S.markers, tempo: S.tempo,
  });
}
function pushHistory() {
  history.undo.push(snapshot());
  if (history.undo.length > 100) history.undo.shift();
  history.redo.length = 0;
}
function restore(json) {
  const d = JSON.parse(json);
  const oldIds = new Set(S.tracks.map(t => t.id));
  S.tracks = d.tracks; S.markers = d.markers; S.tempo = d.tempo;
  $('#tempoIn').value = S.tempo;
  // rebuild audio for tracks that appeared/disappeared
  for (const id of oldIds) if (!trackById(id)) destroyLiveChain(id);
  for (const t of S.tracks) {
    if (t.vol === null) t.vol = -Infinity;
    if (!live.has(t.id)) createLiveChain(t); else rewire(t);
    live.get(t.id).plugins.forEach((p, i) => { if (p && p.set && t.inserts[i]) p.set(t.inserts[i].params); });
    applyMix(t);
  }
  S.selClips.clear();
  refreshAll();
}
function undo() { if (!history.undo.length) return status('Nothing to undo'); history.redo.push(snapshot()); restore(history.undo.pop()); status('Undo'); }
function redo() { if (!history.redo.length) return status('Nothing to redo'); history.undo.push(snapshot()); restore(history.redo.pop()); status('Redo'); }

// ───────────────────────── Audio engine ─────────────────────────
const AC = window.AudioContext || window.webkitAudioContext;
const ctx = new AC({ latencyHint: 'interactive' });
const live = new Map(); // track id -> live node chain

const PLUGINS = {
  eq: { name: 'EQ III 3-Band', short: 'EQ3', params: [
    { k: 'low', label: 'Low shelf', min: -18, max: 18, step: 0.1, def: 0, unit: 'dB' },
    { k: 'lowF', label: 'Low freq', min: 40, max: 400, step: 1, def: 120, unit: 'Hz' },
    { k: 'mid', label: 'Mid gain', min: -18, max: 18, step: 0.1, def: 0, unit: 'dB' },
    { k: 'midF', label: 'Mid freq', min: 200, max: 6000, step: 1, def: 1000, unit: 'Hz' },
    { k: 'q', label: 'Mid Q', min: 0.2, max: 8, step: 0.01, def: 1, unit: '' },
    { k: 'high', label: 'High shelf', min: -18, max: 18, step: 0.1, def: 0, unit: 'dB' },
    { k: 'highF', label: 'High freq', min: 2000, max: 16000, step: 10, def: 8000, unit: 'Hz' },
  ] },
  filter: { name: 'Filter', short: 'Filt', params: [
    { k: 'type', label: 'Type', options: ['lowpass', 'highpass', 'bandpass'], def: 'lowpass' },
    { k: 'freq', label: 'Cutoff', min: 30, max: 18000, step: 1, def: 8000, unit: 'Hz', log: true },
    { k: 'q', label: 'Resonance', min: 0.1, max: 18, step: 0.01, def: 0.7, unit: '' },
  ] },
  comp: { name: 'Dyn III Compressor', short: 'Comp', params: [
    { k: 'threshold', label: 'Threshold', min: -60, max: 0, step: 0.1, def: -18, unit: 'dB' },
    { k: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, def: 4, unit: ':1' },
    { k: 'knee', label: 'Knee', min: 0, max: 40, step: 0.1, def: 6, unit: 'dB' },
    { k: 'attack', label: 'Attack', min: 0.1, max: 200, step: 0.1, def: 10, unit: 'ms' },
    { k: 'release', label: 'Release', min: 10, max: 1000, step: 1, def: 120, unit: 'ms' },
    { k: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.1, def: 3, unit: 'dB' },
  ] },
  delay: { name: 'Mod Delay III', short: 'Dly', params: [
    { k: 'time', label: 'Time', min: 10, max: 1500, step: 1, def: 375, unit: 'ms' },
    { k: 'feedback', label: 'Feedback', min: 0, max: 95, step: 1, def: 35, unit: '%' },
    { k: 'tone', label: 'Tone', min: 500, max: 16000, step: 10, def: 5000, unit: 'Hz' },
    { k: 'mix', label: 'Mix', min: 0, max: 100, step: 1, def: 25, unit: '%' },
  ] },
  reverb: { name: 'D-Verb', short: 'Verb', params: [
    { k: 'decay', label: 'Decay', min: 0.2, max: 8, step: 0.1, def: 2.2, unit: 's' },
    { k: 'predelay', label: 'Pre-delay', min: 0, max: 200, step: 1, def: 20, unit: 'ms' },
    { k: 'tone', label: 'Damping', min: 1000, max: 16000, step: 10, def: 7000, unit: 'Hz' },
    { k: 'mix', label: 'Mix', min: 0, max: 100, step: 1, def: 22, unit: '%' },
  ] },
  trim: { name: 'Trim', short: 'Trim', params: [
    { k: 'gain', label: 'Gain', min: -24, max: 24, step: 0.1, def: 0, unit: 'dB' },
    { k: 'phase', label: 'Phase invert', options: ['off', 'on'], def: 'off' },
  ] },
};
const defaultParams = type => Object.fromEntries(PLUGINS[type].params.map(p => [p.k, p.def]));

function makeImpulse(c, decay) {
  const len = Math.max(1, Math.floor(c.sampleRate * decay));
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return ir;
}

function makePlugin(c, ins) {
  const p = ins.params;
  const input = c.createGain(), output = c.createGain();
  const P = { type: ins.type, input, output, nodes: {} };
  switch (ins.type) {
    case 'eq': {
      const lo = c.createBiquadFilter(); lo.type = 'lowshelf';
      const mid = c.createBiquadFilter(); mid.type = 'peaking';
      const hi = c.createBiquadFilter(); hi.type = 'highshelf';
      input.connect(lo).connect(mid).connect(hi).connect(output);
      P.nodes = { lo, mid, hi };
      P.set = q => { lo.gain.value = q.low; lo.frequency.value = q.lowF; mid.gain.value = q.mid; mid.frequency.value = q.midF; mid.Q.value = q.q; hi.gain.value = q.high; hi.frequency.value = q.highF; };
      P.filters = [lo, mid, hi];
      break;
    }
    case 'filter': {
      const f = c.createBiquadFilter();
      input.connect(f).connect(output);
      P.set = q => { f.type = q.type; f.frequency.value = q.freq; f.Q.value = q.q; };
      P.filters = [f];
      break;
    }
    case 'comp': {
      const k = c.createDynamicsCompressor(), mk = c.createGain();
      input.connect(k).connect(mk).connect(output);
      P.comp = k;
      P.set = q => { k.threshold.value = q.threshold; k.ratio.value = q.ratio; k.knee.value = q.knee; k.attack.value = q.attack / 1000; k.release.value = q.release / 1000; mk.gain.value = dbToGain(q.makeup); };
      break;
    }
    case 'delay': {
      const dry = c.createGain(), wet = c.createGain(), d = c.createDelay(2), fb = c.createGain(), tone = c.createBiquadFilter();
      tone.type = 'lowpass';
      input.connect(dry).connect(output);
      input.connect(d); d.connect(tone).connect(fb).connect(d); tone.connect(wet).connect(output);
      P.set = q => { d.delayTime.value = q.time / 1000; fb.gain.value = q.feedback / 100; tone.frequency.value = q.tone; wet.gain.value = q.mix / 100; dry.gain.value = 1 - (q.mix / 100) * 0.5; };
      break;
    }
    case 'reverb': {
      const dry = c.createGain(), wet = c.createGain(), conv = c.createConvolver(), pre = c.createDelay(1), tone = c.createBiquadFilter();
      tone.type = 'lowpass';
      input.connect(dry).connect(output);
      input.connect(pre).connect(conv).connect(tone).connect(wet).connect(output);
      let lastDecay = null;
      P.set = q => {
        if (q.decay !== lastDecay) { conv.buffer = makeImpulse(c, q.decay); lastDecay = q.decay; }
        pre.delayTime.value = q.predelay / 1000; tone.frequency.value = q.tone;
        wet.gain.value = (q.mix / 100) * 1.2; dry.gain.value = 1 - (q.mix / 100) * 0.6;
      };
      break;
    }
    case 'trim': {
      const g = c.createGain();
      input.connect(g).connect(output);
      P.set = q => { g.gain.value = dbToGain(q.gain) * (q.phase === 'on' ? -1 : 1); };
      break;
    }
  }
  P.set(p);
  return P;
}

// Build a strip chain: input -> inserts -> pan -> fader -> mute -> (out)
function buildChain(c, obj, isLive) {
  const ch = {
    input: c.createGain(),
    pan: c.createStereoPanner(),
    fader: c.createGain(),
    mute: c.createGain(),
    plugins: [null, null, null, null, null],
  };
  ch.pan.connect(ch.fader).connect(ch.mute);
  obj.inserts.forEach((ins, i) => { if (ins) ch.plugins[i] = makePlugin(c, ins); });
  wireInserts(ch, obj);
  if (isLive) {
    ch.split = c.createChannelSplitter(2);
    ch.anL = c.createAnalyser(); ch.anR = c.createAnalyser();
    ch.anL.fftSize = ch.anR.fftSize = 1024;
    ch.mute.connect(ch.split); ch.split.connect(ch.anL, 0); ch.split.connect(ch.anR, 1);
    ch.buf = new Float32Array(1024);
    ch.peakL = 0; ch.peakR = 0; ch.holdL = 0; ch.holdR = 0;
  }
  return ch;
}
function wireInserts(ch, obj) {
  ch.input.disconnect();
  ch.plugins.forEach(p => p && p.output.disconnect());
  let node = ch.input;
  obj.inserts.forEach((ins, i) => {
    const p = ch.plugins[i];
    if (ins && p && !ins.bypass) { node.connect(p.input); node = p.output; }
  });
  node.connect(ch.pan);
}

const masterChain = buildChain(ctx, S.master, true);
masterChain.mute.connect(ctx.destination);

function createLiveChain(t) {
  const ch = buildChain(ctx, t, true);
  ch.mute.connect(masterChain.input);
  live.set(t.id, ch);
  applyMix(t);
  return ch;
}
function destroyLiveChain(id) {
  const ch = live.get(id); if (!ch) return;
  try { ch.mute.disconnect(); } catch (e) {}
  live.delete(id);
}
function rewire(obj) {
  const ch = obj.id === 'master' ? masterChain : live.get(obj.id);
  if (!ch) return;
  // sync plugin instances with insert definitions
  obj.inserts.forEach((ins, i) => {
    const p = ch.plugins[i];
    if (!ins) { if (p) { p.output.disconnect(); ch.plugins[i] = null; } return; }
    if (!p || p.type !== ins.type) { if (p) p.output.disconnect(); ch.plugins[i] = makePlugin(ctx, ins); }
  });
  wireInserts(ch, obj);
}
function audible(t) {
  const anySolo = S.tracks.some(x => x.solo);
  return !t.mute && (!anySolo || t.solo);
}
function applyMix(t) {
  const ch = t.id === 'master' ? masterChain : live.get(t.id);
  if (!ch) return;
  const now = ctx.currentTime;
  ch.fader.gain.setTargetAtTime(dbToGain(t.vol), now, 0.012);
  ch.pan.pan.setTargetAtTime(t.pan, now, 0.012);
  if (t.id !== 'master') ch.mute.gain.setTargetAtTime(audible(t) ? 1 : 0, now, 0.006);
}
const applyAllMix = () => { S.tracks.forEach(applyMix); applyMix(S.master); };

// ───────────────────────── Peaks ─────────────────────────
const PEAK_BLOCK = 256;
function computePeaks(buf) {
  const n = Math.ceil(buf.length / PEAK_BLOCK);
  const mins = new Float32Array(n), maxs = new Float32Array(n);
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  for (let b = 0; b < n; b++) {
    let mn = 1, mx = -1;
    const end = Math.min(buf.length, (b + 1) * PEAK_BLOCK);
    for (let i = b * PEAK_BLOCK; i < end; i++) {
      let v = 0; for (const d of chs) v += d[i]; v /= chs.length;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    mins[b] = mn; maxs[b] = mx;
  }
  return { mins, maxs, rate: buf.sampleRate / PEAK_BLOCK };
}
function addBuffer(buffer, name) {
  const id = uid('buf');
  buffers.set(id, { buffer, peaks: computePeaks(buffer), name });
  return id;
}

// ───────────────────────── Tracks & clips ─────────────────────────
let trackCounter = 0;
function newTrack(name, opts = {}) {
  trackCounter++;
  const t = {
    id: uid('trk'), name: name || 'Audio ' + trackCounter,
    color: opts.color || COLORS[(S.tracks.length) % COLORS.length],
    clips: [], vol: opts.vol ?? 0, pan: opts.pan ?? 0,
    mute: false, solo: false, arm: false, inputMon: false, h: opts.h || 96,
    inserts: opts.inserts || [null, null, null, null, null],
    takes: 0,
  };
  S.tracks.push(t);
  createLiveChain(t);
  return t;
}
function newClip(bufId, start, opts = {}) {
  const b = buffers.get(bufId);
  return {
    id: uid('clp'), bufId, start, offset: opts.offset || 0,
    dur: opts.dur ?? (b.buffer.duration - (opts.offset || 0)),
    name: opts.name || b.name, fadeIn: opts.fadeIn || 0, fadeOut: opts.fadeOut || 0,
  };
}
const sortClips = tr => tr.clips.sort((a, b) => a.start - b.start);

// Split a clip at absolute time t; returns [left, right] or null
function splitClip(tr, c, t) {
  if (t <= c.start + 0.001 || t >= c.start + c.dur - 0.001) return null;
  const leftDur = t - c.start;
  const right = { ...c, id: uid('clp'), start: t, offset: c.offset + leftDur, dur: c.dur - leftDur, fadeIn: 0, name: nextClipName(c.name) };
  c.dur = leftDur; c.fadeOut = 0;
  tr.clips.push(right); sortClips(tr);
  return [c, right];
}
function nextClipName(name) {
  const m = name.match(/^(.*?)(?:-(\d+))?$/);
  return m[1] + '-' + String((parseInt(m[2] || '0', 10) + 1)).padStart(2, '0');
}
function selectedTracks() {
  const ids = S.sel.tracks.size ? [...S.sel.tracks] : [];
  return S.tracks.filter(t => ids.includes(t.id));
}

// ───────────────────────── Demo session synthesis ─────────────────────────
function synthDemo() {
  const sr = ctx.sampleRate, bpm = 120, beat = 60 / bpm, bars = 8, len = Math.floor(bars * 4 * beat * sr);
  const mk = n => ctx.createBuffer(1, n, sr);
  const midi = m => 440 * Math.pow(2, (m - 69) / 12);
  const normalize = (d, peak = 0.8) => { let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); if (m) for (let i = 0; i < d.length; i++) d[i] *= peak / m; };

  // Drums
  const drums = mk(len), dd = drums.getChannelData(0);
  const addKick = t0 => { let ph = 0; const s0 = Math.floor(t0 * sr); for (let i = 0; i < 0.4 * sr && s0 + i < len; i++) { const t = i / sr; const f = 48 + 110 * Math.exp(-t * 32); ph += 2 * Math.PI * f / sr; dd[s0 + i] += Math.sin(ph) * Math.exp(-t * 7.5) * 0.95; } };
  const addSnare = t0 => { const s0 = Math.floor(t0 * sr); let lp = 0; for (let i = 0; i < 0.3 * sr && s0 + i < len; i++) { const t = i / sr; const n = Math.random() * 2 - 1; lp += (n - lp) * 0.5; dd[s0 + i] += lp * Math.exp(-t * 16) * 0.55 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 28) * 0.35; } };
  const addHat = (t0, open) => { const s0 = Math.floor(t0 * sr); let prev = 0; const L = (open ? 0.22 : 0.06) * sr; for (let i = 0; i < L && s0 + i < len; i++) { const t = i / sr; const n = Math.random() * 2 - 1; const hp = n - prev; prev = n; dd[s0 + i] += hp * Math.exp(-t * (open ? 14 : 70)) * 0.13; } };
  for (let b = 0; b < bars; b++) {
    const B = b * 4 * beat;
    addKick(B); addKick(B + 2 * beat); addKick(B + 2.5 * beat);
    if (b % 2 === 1) addKick(B + 3.5 * beat);
    addSnare(B + beat); addSnare(B + 3 * beat);
    for (let e = 0; e < 8; e++) addHat(B + e * beat / 2, e === 7);
  }
  normalize(dd, 0.85);

  // Bass  (Am – F – C – G)
  const prog = [[45, [57, 60, 64]], [41, [57, 60, 65]], [48, [55, 60, 64]], [43, [55, 59, 62]]];
  const bass = mk(len), bd = bass.getChannelData(0);
  for (let b = 0; b < bars; b++) {
    const root = prog[b % 4][0];
    for (let e = 0; e < 8; e++) {
      const note = (e === 3 || e === 7) ? root + 12 : root;
      const f = midi(note), s0 = Math.floor((b * 4 * beat + e * beat / 2) * sr), L = Math.floor(beat / 2 * sr * 0.92);
      let ph = 0, lp = 0, lp2 = 0;
      for (let i = 0; i < L && s0 + i < len; i++) {
        const t = i / sr; ph = (ph + f / sr) % 1;
        const saw = 2 * ph - 1, env = Math.exp(-t * 5);
        const fc = 260 + 1400 * Math.exp(-t * 14), a = 1 - Math.exp(-2 * Math.PI * fc / sr);
        lp += (saw - lp) * a; lp2 += (lp - lp2) * a;
        const rel = Math.min(1, (L - i) / (0.008 * sr));
        bd[s0 + i] += lp2 * env * rel * 0.6;
      }
    }
  }
  normalize(bd, 0.8);

  // Keys pad
  const keys = mk(len), kd = keys.getChannelData(0);
  const barLen = 4 * beat;
  for (let b = 0; b < bars; b++) {
    const s0 = Math.floor(b * barLen * sr), L = Math.floor(barLen * sr);
    for (const m of prog[b % 4][1]) {
      const f = midi(m);
      for (let i = 0; i < L; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.12) * Math.min(1, (barLen - t) / 0.15) * (0.75 + 0.25 * Math.exp(-t * 2));
        const tri = x => 2 / Math.PI * Math.asin(Math.sin(x));
        const v = tri(2 * Math.PI * f * t) * 0.6 + Math.sin(2 * Math.PI * f * 1.003 * t) * 0.4 + Math.sin(2 * Math.PI * f * 2 * t) * 0.12;
        kd[s0 + i] += v * env * 0.2;
      }
    }
  }
  normalize(kd, 0.7);

  // Lead melody, 4 bars, placed at bar 5
  const leadLen = Math.floor(4 * barLen * sr), lead = mk(leadLen), ld = lead.getChannelData(0);
  const mel = [[0, 1, 76], [1, .5, 74], [1.5, .5, 72], [2, 2, 69], [4, 1, 72], [5, 1, 74], [6, 2, 76], [8, 1.5, 79], [9.5, .5, 76], [10, 2, 74], [12, 1, 72], [13, 1, 74], [14, 2, 69]];
  for (const [st, du, m] of mel) {
    const f = midi(m), s0 = Math.floor(st * beat * sr), L = Math.floor(du * beat * sr * 0.95);
    let ph = 0;
    for (let i = 0; i < L && s0 + i < leadLen; i++) {
      const t = i / sr;
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3);
      ph += 2 * Math.PI * f * vib / sr;
      const env = Math.min(1, t / 0.015) * (0.7 + 0.3 * Math.exp(-t * 6)) * Math.min(1, (L - i) / (0.04 * sr));
      ld[s0 + i] += (Math.sin(ph) + 0.32 * Math.sin(3 * ph) + 0.16 * Math.sin(5 * ph) + 0.08 * Math.sin(7 * ph)) * env * 0.4;
    }
  }
  normalize(ld, 0.7);

  const ins = (type, over = {}) => ({ type, bypass: false, params: { ...defaultParams(type), ...over } });
  const tD = newTrack('Drums', { vol: -6, inserts: [ins('eq', { low: 3, high: 2 }), ins('comp', { threshold: -20, ratio: 4, makeup: 4 }), null, null, null] });
  const tB = newTrack('Bass', { vol: -7, inserts: [ins('eq', { low: 2, mid: -3, midF: 400 }), ins('comp', { threshold: -16, ratio: 3, makeup: 2 }), null, null, null] });
  const tK = newTrack('Keys', { vol: -9, pan: -0.3, inserts: [ins('filter', { freq: 4200 }), ins('reverb', { decay: 3, mix: 32 }), null, null, null] });
  const tL = newTrack('Lead', { vol: -8, pan: 0.25, inserts: [ins('delay', { time: 375, feedback: 38, mix: 26 }), ins('reverb', { decay: 2.4, mix: 24 }), null, null, null] });
  tD.clips.push(newClip(addBuffer(drums, 'Drums_01'), 0));
  tB.clips.push(newClip(addBuffer(bass, 'Bass_01'), 0));
  tK.clips.push(newClip(addBuffer(keys, 'Keys_01'), 0, { fadeIn: 0.6 }));
  tL.clips.push(newClip(addBuffer(lead, 'Lead_01'), 4 * barLen, { fadeOut: 0.4 }));
  [tD, tB, tK, tL].forEach(rewire);
  S.markers.push({ id: uid('mk'), t: 0, name: 'Intro' }, { id: uid('mk'), t: 4 * barLen, name: 'Melody' });
  S.name = 'Demo Session';
  $('#sessionName').textContent = S.name;
}

// ───────────────────────── Transport ─────────────────────────
const T = { playing: false, recArmed: false, recording: false, segs: [], sources: [], lastClickCtx: 0, playStart: 0, recStart: 0 };
let micStream = null, micSource = null, micAnalyser = null, recorder = null, recChunks = [];

function loopRange() {
  if (S.loop && S.sel.end - S.sel.start > 0.05) return [S.sel.start, S.sel.end];
  return null;
}
function schedule(fromT, toT, when) {
  for (const tr of S.tracks) {
    const ch = live.get(tr.id);
    for (const c of tr.clips) {
      const cs = c.start, ce = c.start + c.dur;
      if (ce <= fromT || cs >= toT || c.muted) continue;
      const a = Math.max(fromT, cs), b = Math.min(toT, ce);
      const w = when + (a - fromT);
      if (c.type === 'midi') { scheduleMidiClip(ctx, ch.input, tr, c, a - cs, b - cs, w, true); continue; }
      const uA = a - cs, uB = b - cs;
      const src = ctx.createBufferSource();
      src.buffer = buffers.get(c.bufId).buffer;
      const g = ctx.createGain();
      // fades in clip-local time u
      const levelAt = u => {
        let v = 1;
        if (c.fadeIn > 0 && u < c.fadeIn) v = Math.min(v, u / c.fadeIn);
        if (c.fadeOut > 0 && u > c.dur - c.fadeOut) v = Math.min(v, (c.dur - u) / c.fadeOut);
        return clamp(v, 0, 1);
      };
      g.gain.setValueAtTime(levelAt(uA), w);
      if (c.fadeIn > 0 && uA < c.fadeIn) g.gain.linearRampToValueAtTime(levelAt(Math.min(c.fadeIn, uB)), w + (Math.min(c.fadeIn, uB) - uA));
      if (c.fadeOut > 0 && uB > c.dur - c.fadeOut) {
        const fo = Math.max(uA, c.dur - c.fadeOut);
        g.gain.setValueAtTime(levelAt(fo), w + (fo - uA));
        g.gain.linearRampToValueAtTime(levelAt(uB), w + (uB - uA));
      }
      const cg = ctx.createGain(); cg.gain.value = clipLevel(c);
      src.connect(g).connect(cg).connect(ch.input);
      src.start(w, c.offset + uA, uB - uA);
      T.sources.push(src);
      src.onended = () => { const i = T.sources.indexOf(src); if (i >= 0) T.sources.splice(i, 1); g.disconnect(); };
    }
  }
  T.segs.push({ ctxStart: when, tStart: fromT, tEnd: toT });
}
function currentPos() {
  if (!T.playing) return S.sel.start;
  const now = ctx.currentTime;
  let seg = T.segs[0];
  for (const s of T.segs) if (s.ctxStart <= now) seg = s;
  return Math.max(seg.tStart, seg.tStart + (now - seg.ctxStart));
}
async function play() {
  if (T.playing) return;
  if (ctx.state !== 'running') await ctx.resume();
  const lr = T.recArmed ? null : loopRange();
  let from = lr ? lr[0] : S.sel.start;
  if (T.recArmed) {
    const armed = S.tracks.filter(t => t.arm && t.kind !== 'inst');
    const midiArmed = S.tracks.filter(t => t.arm && t.kind === 'inst');
    if (!armed.length && !midiArmed.length) { status('Record-enable at least one track (R) before recording'); T.recArmed = false; updateTransportUI(); return; }
    recorder = null;
    if (armed.length) {
      const ok = await ensureMic();
      if (!ok) { T.recArmed = false; updateTransportUI(); return; }
      recChunks = [];
      recorder = new MediaRecorder(micStream);
      recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
      recorder.start();
    }
    midiRecStart(midiArmed, from);
    T.recording = true; T.recStart = from; T.recCtxStart = ctx.currentTime + 0.08;
    nextTakeColor();
  }
  T.playing = true; T.segs = []; T.sources = []; T.playStart = from;
  const when = ctx.currentTime + 0.08;
  T.lastClickCtx = when - 0.01;
  schedule(from, lr ? lr[1] : Infinity, when);
  updateTransportUI();
  status(T.recording ? 'Recording…' : 'Playing');
}
function stop() {
  if (!T.playing) { // second stop returns to start of selection
    return;
  }
  const pos = currentPos();
  T.sources.forEach(s => { try { s.stop(); } catch (e) {} });
  T.sources = []; T.segs = []; T.playing = false;
  midiStopAll();
  if (T.recording) finishRecording(pos);
  if (S.insertionFollows) { S.sel.start = S.sel.end = pos; S.playhead = pos; }
  else S.playhead = S.sel.start;
  updateTransportUI(); dirty(); status('Stopped');
}
function togglePlay() { T.playing ? stop() : play(); }
function recordNow() {
  if (T.playing) { stop(); return; }
  T.recArmed = true; play();
}
async function ensureMic() {
  if (micStream) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(S.audioIn ? { deviceId: { exact: S.audioIn } } : {}) } });
    micSource = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 1024;
    micSource.connect(micAnalyser);
    return true;
  } catch (e) {
    status('Microphone unavailable: allow audio input in your browser to record');
    return false;
  }
}
function finishRecording(endPos) {
  T.recording = false; T.recArmed = false;
  midiRecFinish(endPos);
  if (!recorder) return;
  const armed = S.tracks.filter(t => t.arm && t.kind !== 'inst');
  const recStart = T.recStart;
  const lat = 0.08 + (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  recorder.onstop = async () => {
    try {
      const blob = new Blob(recChunks, { type: recorder.mimeType });
      const ab = await blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      pushHistory();
      for (const tr of armed) {
        tr.takes++;
        const name = tr.name.replace(/\s+/g, '_') + '_' + String(tr.takes).padStart(2, '0');
        const bid = addBuffer(buf, name);
        const off = Math.min(lat, buf.duration - 0.01);
        const dur = Math.min(buf.duration - off, Math.max(0.05, endPos - recStart));
        // record replaces material underneath (destructive-punch style on the playlist)
        carveRange(tr, recStart, recStart + dur);
        tr.clips.push(Object.assign(newClip(bid, recStart, { offset: off, dur, name }), takeTag()));
        sortClips(tr);
      }
      status('Recorded ' + dur2(endPos - recStart) + ' on ' + armed.map(t => t.name).join(', '));
      refreshAll();
    } catch (e) { status('Could not decode the recording'); }
  };
  recorder.stop();
}
const dur2 = s => s.toFixed(2) + ' s';
// automatic take colours: every record pass gets its own colour, shared by all tracks recorded in that pass
const TAKE_COLORS = ['#e0604f', '#4f9de0', '#5fc46a', '#e0b14f', '#a46fe0', '#45c9c0', '#e07fb8', '#b5c24a', '#e08a45', '#7f8fe8'];
function nextTakeColor() {
  let seq = 0; S.tracks.forEach(t => [t.clips, ...(t.playlists || []).map(p => p.clips || [])].forEach(cl => (cl || []).forEach(c => { if (c.takeSeq > seq) seq = c.takeSeq; })));
  T.takeSeq = seq + 1; T.takeColor = TAKE_COLORS[(T.takeSeq - 1) % TAKE_COLORS.length];
}
const takeTag = () => (PREF.get('takeColors', true) && T.takeSeq ? { color: T.takeColor, takeSeq: T.takeSeq } : {});
// song sections: markers named Verse, Chorus and so on get a colour and a band on the ruler
const SECTION_TYPES = [['Intro', '#8e8cd8'], ['Verse', '#4f8fe0'], ['Pre-Chorus', '#3fb8b0'], ['Chorus', '#e0604f'], ['Bridge', '#a46fe0'], ['Solo', '#e0b14f'], ['Breakdown', '#8fb04a'], ['Outro', '#8a939c']];
const _secKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const sectionType = name => { const n = _secKey(name); return SECTION_TYPES.find(([k]) => n.startsWith(_secKey(k))); };
const isSection = m => !!(m.color || sectionType(m.name));
const markerColor = m => m.color || sectionType(m.name)?.[1] || '#e7c83c';
function sectionRange(m) {
  const i = S.markers.indexOf(m), nx = S.markers[i + 1];
  return [m.t, nx ? nx.t : Math.max(m.t + 4 * beatSec(), sessionEnd())];
}
function selectSectionAt(t) {
  let m = null; for (const k of S.markers) { if (k.t <= t + 1e-6) m = k; else break; }
  if (!m || !isSection(m)) return false;
  const [a, b] = sectionRange(m); if (b - a < 0.01) return false;
  S.sel.start = a; S.sel.end = b; if (!T.playing) S.playhead = a; S.selClips.clear();
  S.sel.tracks = new Set(S.tracks.map(t => t.id));
  renderHeaders(); dirty();
  status(m.name + ' is selected. Turn on Loop to repeat it, or copy it and paste it somewhere else.');
  return true;
}
// press on a marker flag: drag to move it, tap to go there
function markerPress(m, e, r) {
  const x0 = e.clientX; let moved = false;
  const mv = ev => {
    if (!moved && Math.abs(ev.clientX - x0) < 4) return;
    if (!moved) pushHistory();
    moved = true; m.t = snap(Math.max(0, xToT(ev.clientX - r.left))); S.markers.sort((a, b) => a.t - b.t); dirty();
  };
  const up = () => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    if (moved) return status('Moved ' + m.name + ' to bar ' + String(bbt(m.t)).trim().split('|')[0].trim());
    setInsertion(m.t);
    if (S.simple && typeof sectionDialog === 'function') sectionDialog(m);
  };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
const clipColor = (c, tr) => (c.color && PREF.get('takeColors', true)) ? c.color : tr.color;

// metronome lookahead
function scheduleClicks() {
  if (!S.click || !T.playing) return;
  const now = ctx.currentTime, horizon = now + 0.15, b = beatSec();
  for (const seg of T.segs) {
    const segEndCtx = seg.ctxStart + (seg.tEnd - seg.tStart);
    if (segEndCtx < now || seg.ctxStart > horizon) continue;
    const tFrom = seg.tStart + Math.max(0, Math.max(now, T.lastClickCtx) - seg.ctxStart);
    const tTo = Math.min(seg.tEnd, seg.tStart + (horizon - seg.ctxStart));
    for (let k = Math.ceil(tFrom / b - 1e-6); k * b < tTo; k++) {
      const w = seg.ctxStart + (k * b - seg.tStart);
      if (w <= T.lastClickCtx + 0.001) continue;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = k % 4 === 0 ? 1760 : 1320;
      g.gain.setValueAtTime(0.0001, w); g.gain.exponentialRampToValueAtTime(0.35, w + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, w + 0.05);
      o.connect(g).connect(ctx.destination); o.start(w); o.stop(w + 0.06);
      T.lastClickCtx = w;
    }
  }
}
function loopTick() {
  if (!T.playing || !T.segs.length) return;
  const last = T.segs[T.segs.length - 1];
  if (last.tEnd === Infinity) return;
  const endCtx = last.ctxStart + (last.tEnd - last.tStart);
  if (endCtx - ctx.currentTime < 0.25) {
    const lr = loopRange();
    if (lr) schedule(lr[0], lr[1], endCtx);
    else schedule(last.tEnd, Infinity, endCtx);
  }
  // trim old segments
  while (T.segs.length > 2 && T.segs[1].ctxStart < ctx.currentTime - 0.5) T.segs.shift();
}

// ───────────────────────── Bounce / export ─────────────────────────
async function bounce() {
  const end = sessionEnd();
  if (end <= 0) return status('Nothing to bounce');
  const range = S.sel.end - S.sel.start > 0.05 ? [S.sel.start, S.sel.end] : [0, end + 1.5];
  const len = range[1] - range[0];
  openModal('Bounce Mix', `<p>Rendering ${minsec(len, 2)} of audio (${minsec(range[0], 2)} – ${minsec(range[1], 2)}) to a 16-bit stereo WAV file…</p>`, []);
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  const m = buildChain(off, S.master, false);
  m.fader.gain.value = dbToGain(S.master.vol); m.pan.pan.value = 0;
  m.mute.connect(off.destination);
  for (const tr of S.tracks) {
    if (!audible(tr)) continue;
    const ch = buildChain(off, tr, false);
    ch.fader.gain.value = dbToGain(tr.vol); ch.pan.pan.value = tr.pan;
    ch.mute.connect(m.input);
    for (const c of tr.clips) {
      const cs = c.start, ce = cs + c.dur;
      if (ce <= range[0] || cs >= range[1]) continue;
      const a = Math.max(range[0], cs), b = Math.min(range[1], ce), w = a - range[0], uA = a - cs;
      if (c.type === 'midi') { if (!c.muted) scheduleMidiClip(off, ch.input, tr, c, uA, b - cs, w, false); continue; }
      const src = off.createBufferSource(); src.buffer = buffers.get(c.bufId).buffer;
      const g = off.createGain();
      g.gain.setValueAtTime(c.fadeIn > 0 && uA < c.fadeIn ? uA / c.fadeIn : 1, w);
      if (c.fadeIn > 0 && uA < c.fadeIn) g.gain.linearRampToValueAtTime(1, w + c.fadeIn - uA);
      if (c.fadeOut > 0) { const fo = cs + c.dur - c.fadeOut - range[0]; if (fo > w) g.gain.setValueAtTime(1, fo); g.gain.linearRampToValueAtTime(0, ce - range[0]); }
      const cg = off.createGain(); cg.gain.value = clipLevel(c);
      src.connect(g).connect(cg).connect(ch.input);
      src.start(w, c.offset + uA, b - a);
    }
  }
  const out = await off.startRendering();
  const blob = encodeWav(out);
  const url = URL.createObjectURL(blob);
  const fname = S.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '_Bounce.wav';
  openModal('Bounce Complete', `<p>Your mix is ready: <b>${fname}</b> (${(blob.size / 1048576).toFixed(1)} MB).</p><audio controls src="${url}" style="width:100%"></audio>`,
    [{ label: 'Close' }, { label: 'Download WAV', primary: true, action: () => { const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove(); return false; } }]);
}
function encodeWav(buf) {
  const nch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const ab = new ArrayBuffer(44 + len * nch * 2), v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + len * nch * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, len * nch * 2, true);
  const chs = []; for (let c = 0; c < nch; c++) chs.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) { const s = clamp(chs[c][i], -1, 1); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
}

// ───────────────────────── Import ─────────────────────────
async function importFiles(files, targetTrack, at) {
  const list = [...files].filter(f => f.type.startsWith('audio') || /\.(wav|mp3|aif|aiff|m4a|ogg|flac|webm)$/i.test(f.name));
  if (!list.length) return status('No audio files found');
  status('Importing ' + list.length + ' file(s)…');
  pushHistory();
  let n = 0;
  for (const f of list) {
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      const base = f.name.replace(/\.[^.]+$/, '');
      const bid = addBuffer(buf, base);
      const tr = (targetTrack && n === 0) ? targetTrack : newTrack(base.slice(0, 24));
      tr.clips.push(newClip(bid, at ?? S.sel.start)); sortClips(tr);
      n++;
    } catch (e) { status('Could not decode ' + f.name); }
  }
  status('Imported ' + n + ' file(s)');
  refreshAll();
}

// ───────────────────────── Editing commands ─────────────────────────
// Remove material in [a,b] on a track (splitting edge clips)
function carveRange(tr, a, b) {
  for (const c of [...tr.clips]) { if (c.start < a && c.start + c.dur > a) splitClip(tr, c, a); }
  for (const c of [...tr.clips]) { if (c.start < b && c.start + c.dur > b) splitClip(tr, c, b); }
  tr.clips = tr.clips.filter(c => !(c.start >= a - 1e-6 && c.start + c.dur <= b + 1e-6));
}
function cmdSeparate() {
  const trs = selectedTracks().length ? selectedTracks() : S.tracks;
  pushHistory();
  let n = 0;
  const { start, end } = S.sel;
  for (const tr of trs) {
    for (const c of [...tr.clips]) if (splitClip(tr, c, start)) n++;
    if (end - start > 0.001) for (const c of [...tr.clips]) if (splitClip(tr, c, end)) n++;
  }
  status(n ? 'Separated clip' + (n > 1 ? 's' : '') : 'No clip under the cursor to separate');
  dirty(); renderClipList();
}
function cmdDelete() {
  if (S.selClips.size) {
    pushHistory();
    for (const id of S.selClips) {
      const f = findClip(id); if (!f) continue;
      f.tr.clips = f.tr.clips.filter(c => c.id !== id);
      if (S.mode === 'shuffle') f.tr.clips.forEach(c => { if (c.start > f.c.start) c.start -= f.c.dur; });
    }
    S.selClips.clear(); dirty(); renderClipList(); return status('Deleted clip');
  }
  const { start, end } = S.sel;
  if (end - start <= 0.001) return status('Make a selection to delete');
  pushHistory();
  for (const tr of selectedTracks()) {
    carveRange(tr, start, end);
    if (S.mode === 'shuffle') tr.clips.forEach(c => { if (c.start >= end - 1e-6) c.start -= end - start; });
  }
  if (S.mode === 'shuffle' && selectedTracks().length === S.tracks.length) {   // markers follow the edit
    S.markers = S.markers.filter(m => !(m.t > start + 1e-6 && m.t < end - 1e-6));
    S.markers.forEach(m => { if (m.t >= end - 1e-6) m.t -= end - start; });
  }
  if (S.mode === 'shuffle') S.sel.end = start;
  dirty(); renderClipList(); status('Cleared selection');
}
let clipboard = null;
function gatherCopy() {
  if (S.selClips.size) {
    const items = [...S.selClips].map(findClip).filter(Boolean);
    const t0 = Math.min(...items.map(i => i.c.start));
    const trIdx = Math.min(...items.map(i => S.tracks.indexOf(i.tr)));
    return { len: Math.max(...items.map(i => i.c.start + i.c.dur)) - t0, items: items.map(i => ({ rel: S.tracks.indexOf(i.tr) - trIdx, c: { ...i.c, start: i.c.start - t0 } })) };
  }
  const { start, end } = S.sel;
  if (end - start <= 0.001) return null;
  const trs = selectedTracks(); if (!trs.length) return null;
  const base = S.tracks.indexOf(trs[0]);
  const items = [];
  for (const tr of trs) for (const c of tr.clips) {
    const a = Math.max(start, c.start), b = Math.min(end, c.start + c.dur);
    if (b - a > 0.001) items.push({ rel: S.tracks.indexOf(tr) - base, c: { ...c, start: a - start, offset: c.offset + (a - c.start), dur: b - a, fadeIn: a > c.start ? 0 : c.fadeIn, fadeOut: b < c.start + c.dur ? 0 : c.fadeOut } });
  }
  return { len: end - start, items };
}
function cmdCopy(cut = false) {
  const cb = gatherCopy();
  if (!cb) return status('Nothing selected to copy');
  clipboard = cb;
  if (cut) cmdDelete(); else status('Copied ' + cb.items.length + ' clip(s)');
}
function pasteAt(cb, at, firstTrackIdx) {
  pushHistory();
  const added = [];
  for (const it of cb.items) {
    const tr = S.tracks[firstTrackIdx + it.rel]; if (!tr) continue;
    const c = { ...it.c, id: uid('clp'), start: at + it.c.start };
    carveRange(tr, c.start, c.start + c.dur);
    tr.clips.push(c); sortClips(tr); added.push(c.id);
  }
  S.selClips = new Set(added);
  dirty(); renderClipList();
  return added.length;
}
function cmdPaste() {
  if (!clipboard) return status('Clipboard is empty');
  const trs = selectedTracks();
  const idx = trs.length ? S.tracks.indexOf(trs[0]) : 0;
  const n = pasteAt(clipboard, S.sel.start, idx);
  status('Pasted ' + n + ' clip(s)');
}
function cmdDuplicate() {
  const cb = gatherCopy();
  if (!cb) return status('Select something to duplicate');
  let at, idx;
  if (S.selClips.size) {
    const items = [...S.selClips].map(findClip);
    at = Math.max(...items.map(i => i.c.start + i.c.dur));
    idx = Math.min(...items.map(i => S.tracks.indexOf(i.tr)));
  } else { at = S.sel.end; idx = S.tracks.indexOf(selectedTracks()[0]); S.sel.start = at; S.sel.end = at + cb.len; }
  pasteAt(cb, at, idx);
  status('Duplicated');
}
function cmdSelectAll() {
  S.sel.start = 0; S.sel.end = Math.max(sessionEnd(), 0.001);
  S.sel.tracks = new Set(S.tracks.map(t => t.id)); S.selClips.clear();
  S.playhead = 0; dirty(); renderHeaders();
}
function cmdAddMarker() {
  const t = currentPos();
  pushHistory();
  S.markers.push({ id: uid('mk'), t, name: 'Marker ' + (S.markers.length + 1) });
  S.markers.sort((a, b) => a.t - b.t);
  dirty(); status('Added marker at ' + bbt(t).trim());
}
function cmdNudge(dir) {
  const step = typeof nudgeSec === 'function' ? nudgeSec() : (S.mode === 'grid' ? gridSec() : beatSec());
  if (S.selClips.size) {
    pushHistory();
    for (const id of S.selClips) { const f = findClip(id); if (f.c.locked) continue; f.c.start = Math.max(0, f.c.start + dir * step); }
    dirty(); return;
  }
  const t = Math.max(0, snap(S.sel.start) + dir * step);
  setInsertion(t);
}
function setInsertion(t, keepTracks = true) {
  S.sel.start = S.sel.end = t;
  if (!T.playing) S.playhead = t;
  if (!keepTracks) S.sel.tracks.clear();
  dirty();
}
function zoom(f, anchorT) {
  const a = anchorT ?? (T.playing ? currentPos() : S.sel.start);
  const ax = tToX(a);
  S.pps = clamp(S.pps * f, 1.5, 3000);
  S.scrollT = Math.max(0, a - ax / S.pps);
  if (ax < 0 || ax > lanesW) S.scrollT = Math.max(0, a - lanesW / 2 / S.pps);
  dirty();
}
function zoomFit() {
  const end = Math.max(sessionEnd(), 8);
  S.pps = clamp((lanesW - 30) / end, 1.5, 3000); S.scrollT = 0; dirty();
}

// ───────────────────────── Edit window rendering ─────────────────────────
const ruler = $('#ruler'), lanes = $('#lanes'), rctx = ruler.getContext('2d'), lctx = lanes.getContext('2d');
let lanesW = 800, lanesH = 400, needsDraw = true;
const dirty = () => { needsDraw = true; };
const tToX = t => (t - S.scrollT) * S.pps;
const xToT = x => S.scrollT + x / S.pps;
const DPR = () => window.devicePixelRatio || 1;

function trackTops() { let y = 0; return S.tracks.map(t => { const r = y; y += t.h; return r; }); }
function sizeCanvases() {
  const wrap = $('#lanesWrap');
  lanesW = Math.max(100, wrap.clientWidth);
  const total = S.tracks.reduce((a, t) => a + t.h, 0);
  lanesH = Math.max($('#editBody').clientHeight, total + 60);
  const d = DPR();
  lanes.width = lanesW * d; lanes.height = lanesH * d; lanes.style.width = lanesW + 'px'; lanes.style.height = lanesH + 'px';
  const rw = ruler.clientWidth || lanesW;
  ruler.width = rw * d; ruler.height = 76 * d;
  dirty();
}
function gridStep() {
  // choose a subdivision step (in beats) that keeps lines >= 9px apart
  const b = beatSec();
  for (const s of [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]) if (s * b * S.pps >= 9) return s;
  return 128;
}
function drawRuler() {
  const d = DPR(), w = ruler.width / d;
  rctx.setTransform(d, 0, 0, d, 0, 0);
  rctx.fillStyle = '#2a2d31'; rctx.fillRect(0, 0, w, 76);
  const rows = [0, 19, 38, 57];
  rctx.fillStyle = '#23262a'; rctx.fillRect(0, 19, w, 19); rctx.fillRect(0, 57, w, 19);
  rctx.strokeStyle = '#00000060'; rctx.beginPath(); rows.slice(1).forEach(y => { rctx.moveTo(0, y + .5); rctx.lineTo(w, y + .5); }); rctx.stroke();
  const t0 = S.scrollT, t1 = xToT(w), b = beatSec();
  // selection highlight
  if (S.sel.end - S.sel.start > 0.0005) {
    const x0 = tToX(S.sel.start), x1 = tToX(S.sel.end);
    rctx.fillStyle = S.loop ? '#3fbf6340' : '#4aa3ff38'; rctx.fillRect(x0, 19, x1 - x0, 38);
    rctx.fillStyle = S.loop ? '#3fbf63' : '#4aa3ff';
    rctx.beginPath(); rctx.moveTo(x0, 19); rctx.lineTo(x0 + 7, 19); rctx.lineTo(x0, 27); rctx.fill();
    rctx.beginPath(); rctx.moveTo(x1, 19); rctx.lineTo(x1 - 7, 19); rctx.lineTo(x1, 27); rctx.fill();
  }
  rctx.font = '10px Inter, sans-serif'; rctx.textBaseline = 'middle';
  // Bars|Beats
  const barPx = 4 * b * S.pps;
  let barEvery = 1; while (barEvery * barPx < 44) barEvery *= 2;
  const step = gridStep();
  for (let k = Math.floor(t0 / (b * step)); k * b * step <= t1; k++) {
    const t = k * b * step, x = Math.round(tToX(t)) + .5, beatsN = k * step;
    const isBar = Math.abs(beatsN % 4) < 1e-6;
    rctx.strokeStyle = isBar ? '#9aa1aa' : '#5b6168';
    rctx.beginPath(); rctx.moveTo(x, isBar ? 21 : 31); rctx.lineTo(x, 38); rctx.stroke();
    const barN = Math.round(beatsN / 4);
    if (isBar && barN % barEvery === 0) { rctx.fillStyle = '#d9dde2'; rctx.fillText(String(barN + 1), x + 4, 28); }
  }
  // Min:Secs
  let ms = 1; for (const s of [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) { ms = s; if (s * S.pps >= 64) break; }
  for (let k = Math.floor(t0 / ms); k * ms <= t1; k++) {
    const t = k * ms, x = Math.round(tToX(t)) + .5;
    rctx.strokeStyle = '#6a7078'; rctx.beginPath(); rctx.moveTo(x, 48); rctx.lineTo(x, 57); rctx.stroke();
    rctx.fillStyle = '#aab0b8'; rctx.fillText(minsec(t, ms < 1 ? 2 : 0), x + 4, 45);
  }
  // Tempo
  rctx.fillStyle = '#e09a4a'; rctx.beginPath(); const tx = tToX(0); rctx.moveTo(tx, 59); rctx.lineTo(tx + 8, 59); rctx.lineTo(tx, 68); rctx.fill();
  rctx.fillStyle = '#e9c08f'; rctx.fillText('♩ = ' + S.tempo, Math.max(tx, 0) + 12, 66.5);
  // Markers
  S.markers.forEach((m, i) => {   // section bands: each section fills the ruler until the next marker
    const col = markerColor(m); if (!isSection(m)) return;
    const x = tToX(m.t), nx = i + 1 < S.markers.length ? tToX(S.markers[i + 1].t) : Math.max(x, tToX(sessionEnd()));
    if (nx < 0 || x > w) return;
    rctx.fillStyle = col + '40'; rctx.fillRect(x, 1, Math.max(0, nx - x), 17);
  });
  for (const m of S.markers) {
    const x = tToX(m.t); if (x < -100 || x > w) continue;
    const col = markerColor(m);
    rctx.fillStyle = col; rctx.beginPath(); rctx.moveTo(x, 3); rctx.lineTo(x + 8, 3); rctx.lineTo(x + 8, 12); rctx.lineTo(x, 17); rctx.fill();
    rctx.fillStyle = shade(col, 60); rctx.fillText(m.name, x + 11, 10);
  }
  // playhead
  const px = Math.round(tToX(currentPos())) + .5;
  rctx.strokeStyle = T.recording ? '#ff4a42' : '#4aa3ff'; rctx.lineWidth = 1.5;
  rctx.beginPath(); rctx.moveTo(px, 19); rctx.lineTo(px, 76); rctx.stroke(); rctx.lineWidth = 1;
}

function drawLanes() {
  const d = DPR();
  lctx.setTransform(d, 0, 0, d, 0, 0);
  lctx.fillStyle = '#1f2124'; lctx.fillRect(0, 0, lanesW, lanesH);
  const tops = trackTops(), b = beatSec(), t0 = S.scrollT, t1 = xToT(lanesW);
  // lane backgrounds
  S.tracks.forEach((tr, i) => {
    const y = tops[i];
    const isSel = S.sel.tracks.has(tr.id);
    lctx.fillStyle = isSel ? '#2b3138' : (i % 2 ? '#25272b' : '#282a2e');
    lctx.fillRect(0, y, lanesW, tr.h);
    lctx.fillStyle = '#121315'; lctx.fillRect(0, y + tr.h - 1, lanesW, 1);
  });
  // grid lines
  const step = gridStep();
  const totalH = tops.length ? tops[tops.length - 1] + S.tracks[S.tracks.length - 1].h : 0;
  for (let k = Math.floor(t0 / (b * step)); k * b * step <= t1; k++) {
    const beatsN = k * step, x = Math.round(tToX(beatsN * b)) + .5;
    const isBar = Math.abs(beatsN % 4) < 1e-6, isBeat = Math.abs(beatsN % 1) < 1e-6;
    lctx.strokeStyle = isBar ? '#4a5058' : isBeat ? '#34383d' : '#2d3034';
    lctx.beginPath(); lctx.moveTo(x, 0); lctx.lineTo(x, totalH); lctx.stroke();
  }
  // markers lines
  lctx.setLineDash([3, 4]);
  for (const m of S.markers) { const x = Math.round(tToX(m.t)) + .5; lctx.strokeStyle = markerColor(m) + '66'; lctx.beginPath(); lctx.moveTo(x, 0); lctx.lineTo(x, totalH); lctx.stroke(); }
  lctx.setLineDash([]);
  // clips
  S.tracks.forEach((tr, i) => {
    const y = tops[i];
    for (const c of tr.clips) drawClip(c, tr, y);
    if (T.recording && tr.arm) {
      const x0 = tToX(T.recStart), x1 = tToX(currentPos());
      lctx.fillStyle = '#b8322c'; lctx.fillRect(x0, y + 2, Math.max(1, x1 - x0), tr.h - 5);
      lctx.fillStyle = '#ffd9d6'; lctx.font = '600 10px Inter, sans-serif'; lctx.fillText('● REC', x0 + 5, y + 13);
    }
  });
  // selection overlay
  const { start, end } = S.sel;
  if (end - start > 0.0005) {
    const x0 = tToX(start), x1 = tToX(end);
    S.tracks.forEach((tr, i) => {
      if (!S.sel.tracks.has(tr.id)) return;
      lctx.fillStyle = 'rgba(160, 205, 255, 0.22)'; lctx.fillRect(x0, tops[i], x1 - x0, tr.h - 1);
      lctx.strokeStyle = 'rgba(160, 205, 255, 0.55)'; lctx.strokeRect(x0 + .5, tops[i] + .5, x1 - x0 - 1, tr.h - 2);
    });
  } else if (!T.playing) {
    const x = Math.round(tToX(start)) + .5;
    S.tracks.forEach((tr, i) => {
      if (!S.sel.tracks.has(tr.id)) return;
      lctx.strokeStyle = '#ffffff'; lctx.beginPath(); lctx.moveTo(x, tops[i]); lctx.lineTo(x, tops[i] + tr.h - 1); lctx.stroke();
    });
  }
  // playhead
  if (T.playing || S.sel.tracks.size === 0) {
    const px = Math.round(tToX(currentPos())) + .5;
    lctx.strokeStyle = T.recording ? '#ff4a42' : '#4aa3ff'; lctx.lineWidth = 1.5;
    lctx.beginPath(); lctx.moveTo(px, 0); lctx.lineTo(px, Math.max(totalH, lanesH)); lctx.stroke(); lctx.lineWidth = 1;
  }
  if (!S.tracks.length) {
    lctx.fillStyle = '#7d848c'; lctx.font = '14px Inter, sans-serif'; lctx.textAlign = 'center';
    lctx.fillText('No tracks yet. Choose Track > New, or drop audio files here.', lanesW / 2, 80); lctx.textAlign = 'left';
  }
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
  return `rgb(${clamp(r, 0, 255)},${clamp(g, 0, 255)},${clamp(b, 0, 255)})`;
}
function drawClip(c, tr, y) {
  const x0 = tToX(c.start), x1 = tToX(c.start + c.dur);
  if (x1 < 0 || x0 > lanesW) return;
  const h = tr.h - 3, top = y + 1, nameH = tr.h >= 70 ? 15 : 0;
  const sel = S.selClips.has(c.id);
  const w = Math.max(1, x1 - x0);
  const col = clipColor(c, tr);
  // body
  lctx.fillStyle = c.muted ? '#2b2e33' : shade(col, -70);
  lctx.fillRect(x0, top, w, h);
  // name bar
  if (nameH) {
    lctx.fillStyle = sel ? '#f2f5f8' : shade(col, -10);
    lctx.fillRect(x0, top, w, nameH);
    lctx.save(); lctx.beginPath(); lctx.rect(x0, top, w, nameH); lctx.clip();
    lctx.fillStyle = sel ? '#1b1d20' : '#0d0f11'; lctx.font = '600 10px Inter, sans-serif'; lctx.textBaseline = 'middle';
    lctx.fillText(c.name, Math.max(x0, 0) + 5, top + nameH / 2 + .5);
    lctx.restore();
  }
  // waveform
  const bd = c.type === 'midi' ? null : buffers.get(c.bufId);
  if (c.type === 'midi') drawMidiNotes(lctx, c, tr, x0, x1, top + nameH + 2, h - nameH - 4, sel);
  if (bd) {
    const pk = bd.peaks, wTop = top + nameH + 2, wH = h - nameH - 4, mid = wTop + wH / 2;
    const xs = Math.max(0, Math.floor(x0)), xe = Math.min(lanesW, Math.ceil(x1));
    lctx.fillStyle = c.muted ? '#6b7076' : sel ? shade(col, 110) : shade(col, 70);
    lctx.save(); lctx.beginPath(); lctx.rect(xs, wTop, xe - xs, wH); lctx.clip();
    lctx.beginPath();
    for (let x = xs; x < xe; x++) {
      const ta = c.offset + (xToT(x) - c.start), tb = c.offset + (xToT(x + 1) - c.start);
      let i0 = Math.floor(ta * pk.rate), i1 = Math.max(i0 + 1, Math.ceil(tb * pk.rate));
      i0 = clamp(i0, 0, pk.mins.length - 1); i1 = clamp(i1, 1, pk.mins.length);
      let mn = 0, mx = 0;
      for (let i = i0; i < i1; i++) { if (pk.mins[i] < mn) mn = pk.mins[i]; if (pk.maxs[i] > mx) mx = pk.maxs[i]; }
      // fade envelope
      const u = xToT(x) - c.start; let env = 1;
      if (c.fadeIn > 0 && u < c.fadeIn) env = u / c.fadeIn;
      if (c.fadeOut > 0 && u > c.dur - c.fadeOut) env = Math.min(env, (c.dur - u) / c.fadeOut);
      env = clamp(env, 0, 1) * Math.min(4, dbToGain(c.gain || 0));
      const a = mid - mx * env * wH / 2, bb = mid - mn * env * wH / 2;
      lctx.rect(x, a, 1, Math.max(1, bb - a));
    }
    lctx.fill(); lctx.restore();
    lctx.fillStyle = '#00000040'; lctx.fillRect(xs, mid, xe - xs, 1);
    if (c.gain && w > 46) { lctx.font = '600 10px Inter, sans-serif'; lctx.textBaseline = 'top'; const lbl = (c.gain > 0 ? '+' : '') + c.gain.toFixed(1) + ' dB'; lctx.fillStyle = '#000000a0'; lctx.fillRect(x1 - 52, wTop + 1, 49, 13); lctx.fillStyle = '#ffd36b'; lctx.fillText(lbl, x1 - 49, wTop + 2); }
  }
  if (c.muted) { lctx.fillStyle = '#1b1d2099'; lctx.fillRect(x0, top, w, h); if (nameH) { lctx.fillStyle = '#c9ced4'; lctx.font = '600 10px Inter, sans-serif'; lctx.textBaseline = 'middle'; lctx.fillText('(muted)', Math.max(x0, 0) + 5, top + nameH + 10); } }
  if (c.locked && nameH) { lctx.fillStyle = '#0d0f11'; lctx.font = '10px Inter, sans-serif'; lctx.textBaseline = 'middle'; lctx.fillText('🔒', x1 - 14, top + nameH / 2 + .5); }
  // fades graphics
  const fadeShape = (xa, xb, rising) => {
    lctx.fillStyle = '#00000055'; lctx.strokeStyle = '#ffffffb0';
    lctx.beginPath();
    if (rising) { lctx.moveTo(xa, top + h); lctx.lineTo(xb, top + nameH); lctx.lineTo(xa, top + nameH); }
    else { lctx.moveTo(xa, top + nameH); lctx.lineTo(xb, top + h); lctx.lineTo(xb, top + nameH); }
    lctx.closePath(); lctx.fill();
    lctx.beginPath();
    if (rising) { lctx.moveTo(xa, top + h); lctx.lineTo(xb, top + nameH); } else { lctx.moveTo(xa, top + nameH); lctx.lineTo(xb, top + h); }
    lctx.stroke();
  };
  if (c.fadeIn > 0) fadeShape(x0, tToX(c.start + c.fadeIn), true);
  if (c.fadeOut > 0) fadeShape(tToX(c.start + c.dur - c.fadeOut), x1, false);
  // border
  lctx.strokeStyle = sel ? '#ffffff' : shade(col, -110);
  lctx.lineWidth = sel ? 1.5 : 1;
  lctx.strokeRect(x0 + .5, top + .5, w - 1, h - 1);
  lctx.lineWidth = 1;
}

// ───────────────────────── Track headers ─────────────────────────
function renderHeaders() {
  const host = $('#trackHeaders');
  host.innerHTML = '';
  for (const tr of S.tracks) {
    const el = document.createElement('div');
    el.className = 'track-header' + (S.sel.tracks.has(tr.id) ? ' selected' : '');
    el.style.height = tr.h + 'px';
    el.dataset.id = tr.id; if (tr.kind) el.dataset.kind = tr.kind;
    const tall = tr.h >= 96, mid = tr.h >= 70;
    el.innerHTML = `
      <div class="color" style="background:${tr.color}"></div>
      <div class="th-main">
        <div class="th-row"><div class="th-name" title="Double-click to rename">${escapeHtml(tr.name)}</div></div>
        <div class="th-row">
          <button class="tbtn rec ${tr.arm ? 'on' : ''}" data-act="arm" title="Record enable">R</button>
          <button class="tbtn inp ${tr.inputMon ? 'on' : ''}" data-act="inp" title="Input monitor">I</button>
          <button class="tbtn solo ${tr.solo ? 'on' : ''}" data-act="solo" title="Solo">S</button>
          <button class="tbtn mute ${tr.mute ? 'on' : ''}" data-act="mute" title="Mute">M</button>
          <div class="spacer"></div>
          <span class="th-vol" title="Volume (drag to adjust)">${fmtDb(tr.vol)} dB</span>
        </div>
        ${mid ? `<div class="th-row"><div class="th-meter"><i data-meter="${tr.id}"></i></div></div>` : ''}
        ${tall ? `<div class="th-row th-mini"><select data-act="height" title="Track height"><option value="56">Small</option><option value="96">Medium</option><option value="140">Large</option></select><span class="th-sub">${tr.kind === 'inst' ? instLabel(tr) : 'In 1 · Out 1-2'} · ${tr.clips.length} clip${tr.clips.length === 1 ? '' : 's'}</span></div>` : ''}
      </div>`;
    const sel = el.querySelector('select'); if (sel) sel.value = String(tr.h);
    host.appendChild(el);
  }
  host.style.minHeight = lanesH + 'px';
}
const escapeHtml = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

$('#trackHeaders').addEventListener('mousedown', e => {
  const el = e.target.closest('.track-header'); if (!el) return;
  const tr = trackById(el.dataset.id);
  const act = e.target.dataset.act;
  if (act === 'height') return;
  if (act) {
    e.preventDefault();
    toggleTrackFlag(tr, act, e.altKey);
    return;
  }
  if (e.target.classList.contains('th-vol')) { dragValue(e, tr.vol, v => { tr.vol = v; applyMix(tr); e.target.textContent = fmtDb(v) + ' dB'; syncStrip(tr); }); return; }
  if (e.target.classList.contains('th-name') && e.target.isContentEditable) return;
  // select track
  if (e.shiftKey || e.metaKey || e.ctrlKey) { S.sel.tracks.has(tr.id) ? S.sel.tracks.delete(tr.id) : S.sel.tracks.add(tr.id); }
  else S.sel.tracks = new Set([tr.id]);
  renderHeaders(); dirty();
});
$('#trackHeaders').addEventListener('change', e => {
  if (e.target.dataset.act === 'height') {
    const tr = trackById(e.target.closest('.track-header').dataset.id);
    tr.h = parseInt(e.target.value, 10); sizeCanvases(); renderHeaders();
  }
});
$('#trackHeaders').addEventListener('dblclick', e => {
  if (!e.target.classList.contains('th-name')) return;
  const tr = trackById(e.target.closest('.track-header').dataset.id);
  renameTrack(tr);
});
function renameTrack(tr) {
  openModal('Rename Track', `<div class="row" style="grid-template-columns:80px 1fr"><label>Name</label><input type="text" id="rnIn" value="${escapeHtml(tr.name)}" maxlength="32"></div>`,
    [{ label: 'Cancel' }, { label: 'OK', primary: true, action: () => { const v = $('#rnIn').value.trim(); if (v) { tr.name = v; refreshAll(); } } }]);
  setTimeout(() => { $('#rnIn').select(); }, 20);
}
function dragValue(e, start, cb, range = [-90, 12], sens = 0.25) {
  e.preventDefault();
  const y0 = e.clientY; let v0 = start === -Infinity ? -60 : start;
  const mv = ev => { let v = clamp(v0 + (y0 - ev.clientY) * sens * (ev.shiftKey ? 0.2 : 1), range[0], range[1]); if (v <= -89.9) v = -Infinity; cb(Math.round(v * 10) / 10); };
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
async function toggleTrackFlag(tr, act, exclusive) {
  if (act === 'solo') {
    if (exclusive) { const v = !tr.solo; S.tracks.forEach(t => t.solo = false); tr.solo = v; } else tr.solo = !tr.solo;
    applyAllMix();
  } else if (act === 'mute') { tr.mute = !tr.mute; applyMix(tr); }
  else if (act === 'arm') {
    tr.arm = !tr.arm;
    if (tr.arm && tr.kind === 'inst') { midiEnsure(); status(tr.name + ' record-enabled for MIDI. Play your pads to hear it, then press Record'); }
    else if (tr.arm) { const ok = await ensureMic(); if (!ok) tr.arm = false; else status(tr.name + ' record-enabled. Press Record, then Play (or Ctrl+Space)'); }
  } else if (act === 'inp') {
    tr.inputMon = !tr.inputMon;
    if (tr.inputMon && tr.kind !== 'inst') { const ok = await ensureMic(); if (!ok) tr.inputMon = false; }
    updateMonitoring();
  }
  renderHeaders(); renderMixer();
}
// direct input monitoring through the track chain
const monitorTaps = new Map();
function updateMonitoring() {
  for (const tr of S.tracks) {
    const has = monitorTaps.has(tr.id);
    if (tr.kind === 'inst') continue;
    if (tr.inputMon && micSource && !has) { const g = ctx.createGain(); micSource.connect(g); g.connect(live.get(tr.id).input); monitorTaps.set(tr.id, g); }
    if ((!tr.inputMon || !micSource) && has) { monitorTaps.get(tr.id).disconnect(); monitorTaps.delete(tr.id); }
  }
}

// ───────────────────────── Lane interaction ─────────────────────────
function hitTest(x, y) {
  const tops = trackTops();
  let ti = -1;
  for (let i = 0; i < S.tracks.length; i++) if (y >= tops[i] && y < tops[i] + S.tracks[i].h) ti = i;
  if (ti < 0) return { ti: -1, t: xToT(x) };
  const tr = S.tracks[ti], t = xToT(x);
  const c = [...tr.clips].reverse().find(c => t >= c.start && t <= c.start + c.dur);
  const r = { ti, tr, t, c, yIn: y - tops[ti] };
  if (c) {
    const x0 = tToX(c.start), x1 = tToX(c.start + c.dur);
    r.edge = (x - x0 < 7 && x1 - x0 > 16) ? 'L' : (x1 - x < 7 && x1 - x0 > 16) ? 'R' : null;
    r.fadeZone = r.yIn < 16 + (tr.h >= 70 ? 0 : 0) && r.yIn > (tr.h >= 70 ? 15 : 0) - 15 ? (x - x0 < 14 ? 'in' : x1 - x < 14 ? 'out' : null) : null;
    if (r.yIn > 22) r.fadeZone = null;
  }
  return r;
}
function effectiveAction(h) {
  if (!h.tr) return 'select';
  const tool = S.tool;
  if (tool === 'select') return 'select';
  if (tool === 'trim') return h.c ? 'trim' : 'select';
  if (tool === 'grab') return h.c ? 'grab' : 'select';
  // smart tool
  if (!h.c) return 'select';
  if (h.fadeZone && h.yIn < 22) return 'fade';
  if (h.edge) return 'trim';
  return h.yIn > h.tr.h / 2 ? 'grab' : 'select';
}
const cursorFor = a => ({ select: 'text', grab: 'grab', trim: 'ew-resize', fade: 'crosshair' }[a] || 'default');
lanes.addEventListener('mousemove', e => {
  if (drag) return;
  const r = lanes.getBoundingClientRect();
  const h = hitTest(e.clientX - r.left, e.clientY - r.top);
  lanes.style.cursor = cursorFor(effectiveAction(h));
});
let drag = null, lastClick = { t: 0, x: 0 };
lanes.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  closeMenus();
  const r = lanes.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const h = hitTest(x, y);
  const act = effectiveAction(h);
  const now = performance.now();
  const dbl = now - lastClick.t < 320 && Math.abs(x - lastClick.x) < 4;
  lastClick = { t: now, x };

  if (act === 'select') {
    if (dbl && h.c) { // double-click selects the whole clip
      S.sel.start = h.c.start; S.sel.end = h.c.start + h.c.dur; S.sel.tracks = new Set([h.tr.id]); S.selClips.clear();
      if (!T.playing) S.playhead = S.sel.start; renderHeaders(); dirty(); return;
    }
    const t = snap(Math.max(0, h.t));
    const anchorTi = h.ti < 0 ? S.tracks.length - 1 : h.ti;
    if (e.shiftKey && S.sel.tracks.size) {
      // extend selection
      if (t < S.sel.start) S.sel.start = t; else S.sel.end = t;
      if (h.tr) S.sel.tracks.add(h.tr.id);
      renderHeaders(); dirty(); return;
    }
    S.selClips.clear();
    S.sel.start = S.sel.end = t;
    S.sel.tracks = new Set(h.tr ? [h.tr.id] : []);
    if (!T.playing) S.playhead = t;
    drag = { kind: 'select', t0: t, ti0: anchorTi };
    renderHeaders();
  } else if (act === 'grab') {
    if (S.mode === 'spot') { spotDialog(h.tr, h.c); return; }
    if (e.shiftKey) { S.selClips.has(h.c.id) ? S.selClips.delete(h.c.id) : S.selClips.add(h.c.id); dirty(); return; }
    if (!S.selClips.has(h.c.id)) S.selClips = new Set([h.c.id]);
    S.sel.tracks = new Set([h.tr.id]);
    S.sel.start = S.sel.end = h.c.start;
    if ([...S.selClips].some(id => findClip(id)?.c.locked)) { S.sel.start = S.sel.end = h.c.start; renderHeaders(); dirty(); return status('Clip is locked (Clip > Lock / Unlock)'); }
    pushHistory();
    const items = [...S.selClips].map(findClip).filter(Boolean).map(f => ({ ...f, s0: f.c.start }));
    drag = { kind: 'grab', t0: h.t, ti0: h.ti, items, grabOffset: h.t - h.c.start, moved: false };
    lanes.style.cursor = 'grabbing';
    renderHeaders();
  } else if (act === 'trim') {
    if (h.c.locked) return status('Clip is locked (Clip > Lock / Unlock)');
    pushHistory();
    const side = h.edge || (h.t - h.c.start < h.c.start + h.c.dur - h.t ? 'L' : 'R');
    drag = { kind: 'trim', tr: h.tr, c: h.c, side, s0: h.c.start, o0: h.c.offset, d0: h.c.dur };
  } else if (act === 'fade') {
    pushHistory();
    drag = { kind: 'fade', c: h.c, side: h.fadeZone };
  }
  dirty();
});
window.addEventListener('mousemove', e => {
  if (!drag) return;
  const r = lanes.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const t = Math.max(0, xToT(x));
  autoScroll(x);
  if (drag.kind === 'select') {
    const st = snap(t);
    S.sel.start = Math.min(drag.t0, st); S.sel.end = Math.max(drag.t0, st);
    const h = hitTest(x, clamp(y, 0, lanesH - 1));
    const ti1 = h.ti < 0 ? (y < 0 ? 0 : S.tracks.length - 1) : h.ti;
    const [a, b] = [Math.min(drag.ti0, ti1), Math.max(drag.ti0, ti1)];
    S.sel.tracks = new Set(S.tracks.slice(Math.max(0, a), b + 1).map(t => t.id));
    if (!T.playing) S.playhead = S.sel.start;
    renderHeaders();
  } else if (drag.kind === 'grab') {
    drag.moved = true;
    const lead = drag.items.find(i => i.c.id === [...S.selClips][0]) || drag.items[0];
    let ns = t - drag.grabOffset;
    if (S.mode === 'grid') ns = snap(ns);
    if (S.mode === 'shuffle') ns = magnet(lead.tr, lead.c, ns);
    const dt = Math.max(-Math.min(...drag.items.map(i => i.s0)), ns - lead.s0);
    drag.items.forEach(i => { i.c.start = i.s0 + dt; });
    // vertical move (single clip) onto another track
    const h = hitTest(x, clamp(y, 0, lanesH - 1));
    if (drag.items.length === 1 && h.tr && h.tr !== lead.tr) {
      lead.tr.clips = lead.tr.clips.filter(c => c !== lead.c);
      h.tr.clips.push(lead.c); lead.tr = h.tr;
      S.sel.tracks = new Set([h.tr.id]); renderHeaders();
    }
    S.sel.start = S.sel.end = lead.c.start;
  } else if (drag.kind === 'trim') {
    const c = drag.c, bdur = c.type === 'midi' ? 36000 : buffers.get(c.bufId).buffer.duration;
    let nt = S.mode === 'grid' ? snap(t) : t;
    if (drag.side === 'L') {
      const minStart = drag.s0 - drag.o0, maxStart = drag.s0 + drag.d0 - 0.02;
      const ns = clamp(nt, Math.max(0, minStart), maxStart);
      c.start = ns; c.offset = drag.o0 + (ns - drag.s0); c.dur = drag.d0 - (ns - drag.s0);
    } else {
      const maxEnd = drag.s0 + (bdur - drag.o0);
      const ne = clamp(nt, drag.s0 + 0.02, maxEnd);
      const oldEnd = c.start + c.dur;
      c.dur = ne - drag.s0;
      if (S.mode === 'shuffle') drag.tr.clips.forEach(o => { if (o !== c && o.start >= oldEnd - 1e-6) o.start += (ne - oldEnd); });
    }
    c.fadeIn = Math.min(c.fadeIn, c.dur); c.fadeOut = Math.min(c.fadeOut, c.dur - c.fadeIn);
  } else if (drag.kind === 'fade') {
    const c = drag.c;
    if (drag.side === 'in') c.fadeIn = clamp(t - c.start, 0, c.dur - c.fadeOut);
    else c.fadeOut = clamp(c.start + c.dur - t, 0, c.dur - c.fadeIn);
  }
  dirty(); updateCounters();
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.kind === 'grab') {
    if (!drag.moved) history.undo.pop();
    drag.items.forEach(i => sortClips(i.tr));
    // overlapping clips: newer move wins (trim what lies underneath)
    if (drag.moved) for (const i of drag.items) { const others = i.tr.clips.filter(o => o !== i.c); i.tr.clips = [i.c]; others.forEach(o => i.tr.clips.push(o)); carveUnder(i.tr, i.c); }
    renderClipList(); renderHeaders();
  }
  if (drag.kind === 'select' && S.sel.end - S.sel.start < 0.0005 && !T.playing) S.playhead = S.sel.start;
  drag = null; dirty();
});
function carveUnder(tr, keep) {
  const a = keep.start, b = keep.start + keep.dur;
  const rest = tr.clips.filter(c => c !== keep);
  tr.clips = [keep];
  for (const c of rest) {
    const cs = c.start, ce = c.start + c.dur;
    if (ce <= a + 1e-6 || cs >= b - 1e-6) { tr.clips.push(c); continue; }
    if (cs < a) { const l = { ...c, id: uid('clp'), dur: a - cs, fadeOut: 0 }; tr.clips.push(l); }
    if (ce > b) { const r = { ...c, id: uid('clp'), start: b, offset: c.offset + (b - cs), dur: ce - b, fadeIn: 0 }; tr.clips.push(r); }
  }
  sortClips(tr);
}
function magnet(tr, c, ns) {
  const edges = [0]; tr.clips.forEach(o => { if (o !== c) edges.push(o.start + o.dur, o.start - c.dur); });
  let best = ns, bd = 12 / S.pps;
  for (const e of edges) if (Math.abs(e - ns) < bd) { bd = Math.abs(e - ns); best = e; }
  return Math.max(0, best);
}
function autoScroll(x) {
  if (x > lanesW - 20) S.scrollT += 8 / S.pps;
  else if (x < 10 && S.scrollT > 0) S.scrollT = Math.max(0, S.scrollT - 8 / S.pps);
}
function spotDialog(tr, c) {
  openModal('Spot Dialog', `<p>Move <b>${escapeHtml(c.name)}</b> to an exact time.</p>
    <div class="row" style="grid-template-columns:110px 1fr"><label>Start (seconds)</label><input type="number" id="spotIn" step="0.001" min="0" value="${c.start.toFixed(3)}"></div>
    <div class="row" style="grid-template-columns:110px 1fr"><label>Start (bar)</label><input type="number" id="spotBar" step="0.25" min="1" value="${(c.start / beatSec() / 4 + 1).toFixed(2)}"></div>`,
    [{ label: 'Cancel' }, { label: 'OK', primary: true, action: () => {
      pushHistory();
      c.start = Math.max(0, parseFloat($('#spotIn').value) || 0);
      sortClips(tr); carveUnder(tr, c); S.selClips = new Set([c.id]); dirty(); renderClipList();
    } }]);
  setTimeout(() => {
    $('#spotBar').addEventListener('input', () => { $('#spotIn').value = ((parseFloat($('#spotBar').value) - 1) * 4 * beatSec()).toFixed(3); });
  }, 0);
}

// Ruler interaction
ruler.addEventListener('mousedown', e => {
  const r = ruler.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const t = snap(Math.max(0, xToT(x)));
  if (y < 19) {
    const m = S.markers.find(m => Math.abs(tToX(m.t) - x) < 8 || (x > tToX(m.t) && x < tToX(m.t) + 10 + m.name.length * 6));
    if (m && e.detail !== 2) return markerPress(m, e, r);
    if (m) { renameMarker(m); return; }
    if (e.detail !== 2 && selectSectionAt(xToT(x))) return;
    if (e.detail === 2) { pushHistory(); S.markers.push({ id: uid('mk'), t, name: 'Marker ' + (S.markers.length + 1) }); S.markers.sort((a, b) => a.t - b.t); dirty(); }
    return;
  }
  if (y >= 57) { if (e.detail === 2) tempoDialog(); return; }
  if (T.playing) { stop(); S.sel.start = S.sel.end = S.playhead = t; play(); return; }
  S.sel.start = S.sel.end = S.playhead = t; S.selClips.clear();
  if (!S.sel.tracks.size) S.sel.tracks = new Set(S.tracks.map(t => t.id));
  const mv = ev => { const t2 = snap(Math.max(0, xToT(ev.clientX - r.left))); S.sel.start = Math.min(t, t2); S.sel.end = Math.max(t, t2); S.playhead = S.sel.start; S.sel.tracks = new Set(S.tracks.map(t => t.id)); renderHeaders(); dirty(); };
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  dirty();
});
function renameMarker(m) {
  openModal('Memory Location', `<div class="row" style="grid-template-columns:80px 1fr"><label>Name</label><input type="text" id="mkIn" value="${escapeHtml(m.name)}"></div><p>Location: ${bbt(m.t).trim()} (${minsec(m.t)})</p>`,
    [{ label: 'Delete', action: () => { pushHistory(); S.markers = S.markers.filter(x => x !== m); dirty(); } }, { label: 'Cancel' }, { label: 'OK', primary: true, action: () => { m.name = $('#mkIn').value || m.name; dirty(); } }]);
}
function tempoDialog() {
  openModal('Tempo', `<div class="row" style="grid-template-columns:80px 1fr"><label>BPM</label><input type="number" id="tIn" min="40" max="240" value="${S.tempo}"></div><p>Changing the tempo moves the grid and click. Audio clips keep their timing.</p>`,
    [{ label: 'Cancel' }, { label: 'OK', primary: true, action: () => setTempo(parseFloat($('#tIn').value)) }]);
}
function setTempo(v) { if (!(v >= 40 && v <= 240)) return; S.tempo = Math.round(v * 100) / 100; $('#tempoIn').value = S.tempo; dirty(); updateCounters(); }

// Wheel: horizontal scroll / zoom
$('#editBody').addEventListener('wheel', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) {
    e.preventDefault();
    const r = lanes.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, xToT(e.clientX - r.left));
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault();
    const d = e.shiftKey ? e.deltaY : e.deltaX;
    S.scrollT = Math.max(0, S.scrollT + d / S.pps); dirty();
  }
}, { passive: false });
ruler.addEventListener('wheel', e => { e.preventDefault(); const r = ruler.getBoundingClientRect(); if (e.ctrlKey || e.metaKey || e.altKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, xToT(e.clientX - r.left)); else { S.scrollT = Math.max(0, S.scrollT + e.deltaX / S.pps); dirty(); } }, { passive: false });
const hs = $('#hscroll');
const scrollMax = () => Math.max(1, Math.max(sessionEnd() + 30, 120) - lanesW / S.pps);
hs.addEventListener('input', () => { S.scrollT = (hs.value / 1000) * scrollMax(); dirty(); });
$('#editBody').addEventListener('scroll', () => {});

// Drag & drop import
const lw = $('#lanesWrap');
['dragenter', 'dragover'].forEach(ev => lw.addEventListener(ev, e => { e.preventDefault(); lw.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => lw.addEventListener(ev, () => lw.classList.remove('dragover')));
lw.addEventListener('drop', e => {
  e.preventDefault();
  const r = lanes.getBoundingClientRect();
  const h = hitTest(e.clientX - r.left, e.clientY - r.top);
  importFiles(e.dataTransfer.files, h.tr, snap(Math.max(0, h.t)));
});
$('#fileIn').addEventListener('change', e => { importFiles(e.target.files, null, S.sel.start); e.target.value = ''; });

// ───────────────────────── Clip list ─────────────────────────
function renderClipList() {
  const ul = $('#clipListItems');
  const items = [];
  for (const tr of S.tracks) for (const c of tr.clips) items.push({ tr, c });
  ul.innerHTML = items.length ? items.map(({ tr, c }) => `<li data-id="${c.id}" class="${S.selClips.has(c.id) ? 'sel' : ''}" title="${escapeHtml(tr.name)} · ${minsec(c.start)} · ${c.dur.toFixed(2)} s"><i style="background:${tr.color}"></i><span>${escapeHtml(c.name)}</span></li>`).join('')
    : '<li style="color:var(--text-faint)">No clips</li>';
}
$('#clipListItems').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  const f = findClip(li.dataset.id); if (!f) return;
  S.selClips = new Set([f.c.id]); S.sel.tracks = new Set([f.tr.id]);
  S.sel.start = f.c.start; S.sel.end = f.c.start + f.c.dur; S.playhead = f.c.start;
  if (tToX(f.c.start) < 0 || tToX(f.c.start) > lanesW) S.scrollT = Math.max(0, f.c.start - 1);
  renderClipList(); renderHeaders(); dirty();
});

// ───────────────────────── Mix window ─────────────────────────
function renderMixer() {
  const host = $('#strips');
  host.innerHTML = '';
  [...S.tracks, S.master].forEach(obj => host.appendChild(buildStrip(obj)));
}
function buildStrip(obj) {
  const isM = obj.id === 'master';
  const el = document.createElement('div');
  el.className = 'strip' + (isM ? ' master' : '') + (!isM && S.sel.tracks.has(obj.id) ? ' selected' : '');
  el.dataset.id = obj.id;
  const slots = obj.inserts.map((ins, i) => `<button class="slot ${ins ? 'filled' : ''} ${ins && ins.bypass ? 'byp' : ''}" data-slot="${i}" title="${ins ? PLUGINS[ins.type].name : 'Insert ' + 'ABCDE'[i]}">${ins ? PLUGINS[ins.type].name : ''}</button>`).join('');
  el.innerHTML = `
    <div class="s-inserts">${slots}</div>
    <div class="s-io"><div>${isM ? 'Bus 1-2' : obj.kind === 'inst' ? instLabel(obj) : 'In 1 (Mono)'}</div><div>${isM ? 'Out 1-2' : 'Out 1-2'}</div></div>
    <div class="s-pan">${isM ? '<span class="pan-val">stereo</span>' : `<div class="knob" title="Pan (drag, double-click to center)" style="--rot:${obj.pan * 135}deg"></div><span class="pan-val">${panLabel(obj.pan)}</span>`}</div>
    <div class="s-btns">${isM ? '' : `<button class="tbtn rec ${obj.arm ? 'on' : ''}" data-act="arm">R</button><button class="tbtn solo ${obj.solo ? 'on' : ''}" data-act="solo">S</button><button class="tbtn mute ${obj.mute ? 'on' : ''}" data-act="mute">M</button>`}</div>
    <div class="s-fader">
      <div class="fader-track"><div class="fader-cap" title="Volume (drag, double-click for 0 dB)"></div></div>
      <canvas class="meter" data-meter="${obj.id}" width="16" height="200"></canvas>
    </div>
    <div class="s-vol">${fmtDb(obj.vol)}</div>
    <div class="s-name"><span>${escapeHtml(obj.name)}</span><i style="background:${isM ? '#c9a24a' : obj.color}"></i></div>`;
  // fader
  const trk = el.querySelector('.fader-track'), cap = el.querySelector('.fader-cap');
  const placeCap = () => { const h = trk.clientHeight - 16; cap.style.top = (8 + (1 - dbToFader(obj.vol)) * h) + 'px'; };
  requestAnimationFrame(placeCap);
  el._placeCap = placeCap;
  const setVol = db => { obj.vol = db; applyMix(obj); placeCap(); el.querySelector('.s-vol').textContent = fmtDb(db); if (!isM) syncHeader(obj); };
  cap.addEventListener('mousedown', e => {
    e.preventDefault();
    const h = trk.clientHeight - 16, y0 = e.clientY, p0 = dbToFader(obj.vol);
    const mv = ev => { const fine = ev.shiftKey || ev.metaKey ? 0.15 : 1; const p = clamp(p0 + (y0 - ev.clientY) / h * fine, 0, 1); let db = faderToDb(p); if (db !== -Infinity) db = Math.round(db * 10) / 10; setVol(db); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
  cap.addEventListener('dblclick', () => setVol(0));
  trk.addEventListener('mousedown', e => { if (e.target !== trk) return; const r = trk.getBoundingClientRect(); const p = clamp(1 - (e.clientY - r.top - 8) / (r.height - 16), 0, 1); setVol(Math.round(faderToDb(p) * 10) / 10 || faderToDb(p)); });
  // pan
  const knob = el.querySelector('.knob');
  if (knob) {
    const setPan = v => { obj.pan = Math.round(v * 100) / 100; applyMix(obj); knob.style.setProperty('--rot', obj.pan * 135 + 'deg'); el.querySelector('.pan-val').textContent = panLabel(obj.pan); };
    knob.addEventListener('mousedown', e => {
      e.preventDefault(); const y0 = e.clientY, p0 = obj.pan;
      const mv = ev => setPan(clamp(p0 + (y0 - ev.clientY) / 120, -1, 1));
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
    knob.addEventListener('dblclick', () => setPan(0));
  }
  el.querySelectorAll('.s-btns .tbtn').forEach(b => b.addEventListener('click', e => toggleTrackFlag(obj, b.dataset.act, e.altKey)));
  el.querySelectorAll('.slot').forEach(b => b.addEventListener('click', e => slotClick(obj, +b.dataset.slot, b, e)));
  el.querySelector('.s-name').addEventListener('dblclick', () => { if (!isM) renameTrack(obj); });
  el.querySelector('.s-name').addEventListener('click', e => { if (isM) return; S.sel.tracks = e.shiftKey ? new Set([...S.sel.tracks, obj.id]) : new Set([obj.id]); $$('.strip').forEach(s => s.classList.toggle('selected', S.sel.tracks.has(s.dataset.id))); renderHeaders(); dirty(); });
  return el;
}
const panLabel = p => Math.abs(p) < 0.005 ? '<C>' : (p < 0 ? '<' + Math.round(-p * 100) : Math.round(p * 100) + '>');
function syncHeader(tr) { const el = $(`.track-header[data-id="${tr.id}"] .th-vol`); if (el) el.textContent = fmtDb(tr.vol) + ' dB'; }
function syncStrip(tr) { const el = $(`.strip[data-id="${tr.id}"]`); if (el) { el._placeCap(); el.querySelector('.s-vol').textContent = fmtDb(tr.vol); } }
function slotClick(obj, i, btn, e) {
  const ins = obj.inserts[i];
  if (ins && !e.altKey) return openPlugin(obj, i);
  const r = btn.getBoundingClientRect();
  const items = Object.entries(PLUGINS).map(([k, p]) => ({ label: p.name, action: () => { obj.inserts[i] = { type: k, bypass: false, params: defaultParams(k) }; rewire(obj); renderMixer(); openPlugin(obj, i); } }));
  if (ins) items.unshift({ label: ins.bypass ? 'Enable' : 'Bypass', action: () => { ins.bypass = !ins.bypass; rewire(obj); renderMixer(); } }, { label: 'Remove', action: () => { obj.inserts[i] = null; rewire(obj); renderMixer(); } }, { sep: true });
  showDropdown(items, r.left, r.bottom + 2);
}
function openPlugin(obj, i) {
  const ins = obj.inserts[i], def = PLUGINS[ins.type];
  const rows = def.params.map(p => p.options
    ? `<div class="row"><label>${p.label}</label><select data-k="${p.k}">${p.options.map(o => `<option ${o === ins.params[p.k] ? 'selected' : ''}>${o}</option>`).join('')}</select><output></output></div>`
    : `<div class="row"><label>${p.label}</label><input type="range" data-k="${p.k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${ins.params[p.k]}"><output data-o="${p.k}">${fmtParam(ins.params[p.k], p)}</output></div>`).join('');
  const hasCurve = ins.type === 'eq' || ins.type === 'filter';
  const hasGR = ins.type === 'comp';
  const m = openModal(`${def.name} — ${obj.name} · Insert ${'ABCDE'[i]}`,
    `<div class="plug-face">${hasCurve ? '<canvas class="eqc" id="eqc"></canvas>' : ''}${hasGR ? '<div class="row"><label>Gain reduction</label><canvas id="grc" height="12" style="width:100%;height:12px;background:#101317;border-radius:2px"></canvas><output id="gro">0.0 dB</output></div>' : ''}${rows}</div>`,
    [{ label: ins.bypass ? 'Enable' : 'Bypass', action: () => { ins.bypass = !ins.bypass; rewire(obj); renderMixer(); } }, { label: 'Remove', action: () => { obj.inserts[i] = null; rewire(obj); renderMixer(); } }, { label: 'Done', primary: true }]);
  const ch = obj.id === 'master' ? masterChain : live.get(obj.id);
  const plug = () => ch.plugins[i];
  const drawCurve = () => {
    const cv = $('#eqc'); if (!cv || !plug()) return;
    const w = cv.clientWidth, h = cv.clientHeight, d = DPR(); cv.width = w * d; cv.height = h * d;
    const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    const N = 200, freqs = new Float32Array(N); for (let k = 0; k < N; k++) freqs[k] = 20 * Math.pow(1000, k / (N - 1));
    const tot = new Float32Array(N).fill(1), mag = new Float32Array(N), ph = new Float32Array(N);
    plug().filters.forEach(f => { f.getFrequencyResponse(freqs, mag, ph); for (let k = 0; k < N; k++) tot[k] *= mag[k]; });
    g.strokeStyle = '#ffffff12'; [100, 1000, 10000].forEach(f => { const x = Math.log(f / 20) / Math.log(1000) * w; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); });
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.fillStyle = '#7d848c'; g.font = '9px Inter'; g.fillText('100', Math.log(5) / Math.log(1000) * w + 3, h - 4); g.fillText('1k', Math.log(50) / Math.log(1000) * w + 3, h - 4); g.fillText('10k', Math.log(500) / Math.log(1000) * w + 3, h - 4);
    g.beginPath();
    for (let k = 0; k < N; k++) { const db = 20 * Math.log10(tot[k] || 1e-6), x = k / (N - 1) * w, y = h / 2 - clamp(db, -24, 24) / 24 * (h / 2 - 6); k ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = '#63f0b4'; g.lineWidth = 2; g.stroke();
    g.lineTo(w, h / 2); g.lineTo(0, h / 2); g.fillStyle = '#63f0b41a'; g.fill();
  };
  m.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('input', () => {
    const p = def.params.find(p => p.k === inp.dataset.k);
    ins.params[p.k] = p.options ? inp.value : parseFloat(inp.value);
    const o = m.querySelector(`[data-o="${p.k}"]`); if (o) o.textContent = fmtParam(ins.params[p.k], p);
    plug() && plug().set(ins.params);
    drawCurve();
  }));
  setTimeout(drawCurve, 10);
  if (hasGR) {
    const tick = () => {
      if (!document.body.contains(m) || $('#modalBack').hidden) return;
      const p = plug(); const gr = p && p.comp ? p.comp.reduction : 0;
      const cv = $('#grc'); if (cv) { const w = cv.clientWidth; cv.width = w; const g = cv.getContext('2d'); g.fillStyle = '#e9a23c'; const v = clamp(-gr / 24, 0, 1) * w; g.fillRect(w - v, 0, v, 12); }
      const o = $('#gro'); if (o) o.textContent = gr.toFixed(1) + ' dB';
      requestAnimationFrame(tick);
    };
    tick();
  }
}
const fmtParam = (v, p) => (p.unit === 'Hz' && v >= 1000 ? (v / 1000).toFixed(2) + ' kHz' : (Math.round(v * 100) / 100) + ' ' + p.unit);

// ───────────────────────── Meters ─────────────────────────
function readPeak(an, buf) { an.getFloatTimeDomainData(buf); let m = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; } return m; }
const meterH = db => clamp((db + 60) / 66, 0, 1);
function updateMeters() {
  const mixVisible = S.view === 'mix';
  const all = [...S.tracks.map(t => [t.id, live.get(t.id)]), ['master', masterChain]];
  for (const [id, ch] of all) {
    if (!ch) continue;
    let l = readPeak(ch.anL, ch.buf), r = readPeak(ch.anR, ch.buf);
    const tr = trackById(id);
    if (tr && (tr.arm || tr.inputMon) && micAnalyser && !T.playing) { const v = readPeak(micAnalyser, ch.buf); l = Math.max(l, v); r = Math.max(r, v); }
    ch.peakL = Math.max(l, ch.peakL * 0.9); ch.peakR = Math.max(r, ch.peakR * 0.9);
    const dl = gainToDb(ch.peakL), dr = gainToDb(ch.peakR);
    const now = performance.now();
    if (dl > (ch.holdLv ?? -99) || now - (ch.holdT || 0) > 1500) { ch.holdLv = Math.max(dl, dr); ch.holdT = now; }
    if (id !== 'master') {
      const bar = document.querySelector(`[data-meter="${id}"]`);
      if (bar && bar.tagName === 'I') bar.style.width = (meterH(Math.max(dl, dr)) * 100) + '%';
    }
    if (mixVisible) {
      const cv = document.querySelector(`canvas.meter[data-meter="${id}"]`);
      if (cv) drawStripMeter(cv, dl, dr, ch.holdLv);
    }
    if (id === 'master') drawMasterBar(dl, dr);
  }
}
function drawStripMeter(cv, dl, dr, hold) {
  const h = cv.clientHeight; if (cv.height !== h) cv.height = h;
  const g = cv.getContext('2d'); g.clearRect(0, 0, 16, h);
  const grad = g.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, '#2fbf62'); grad.addColorStop(0.72, '#3fd06e'); grad.addColorStop(0.8, '#e6d23a'); grad.addColorStop(0.9, '#ef8a2c'); grad.addColorStop(0.92, '#e5423b');
  [[dl, 1], [dr, 9]].forEach(([d, x]) => { const v = meterH(d) * h; g.fillStyle = '#151618'; g.fillRect(x, 0, 6, h); g.fillStyle = grad; g.fillRect(x, h - v, 6, v); });
  if (hold > -60) { g.fillStyle = hold > 0 ? '#ff4a42' : '#e8e8e8'; g.fillRect(1, h - meterH(hold) * h, 14, 1.5); }
  g.fillStyle = '#ffffff22'; [0, -6, -12, -24, -48].forEach(db => g.fillRect(0, h - meterH(db) * h, 16, 1));
}
const mb = $('#masterMeterBar'), mbc = mb.getContext('2d');
function drawMasterBar(dl, dr) {
  const w = 160; mbc.clearRect(0, 0, w, 14);
  [[dl, 1], [dr, 8]].forEach(([d, y]) => { const v = meterH(d) * w; const grad = mbc.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, '#2fbf62'); grad.addColorStop(0.75, '#3fd06e'); grad.addColorStop(0.85, '#e6d23a'); grad.addColorStop(0.92, '#e5423b'); mbc.fillStyle = grad; mbc.fillRect(0, y, v, 5); });
}

// ───────────────────────── Counters & status ─────────────────────────
function updateCounters() {
  const p = currentPos();
  $('#ctrMain').textContent = bbt(p);
  $('#ctrSub').textContent = minsec(p);
  $('#selStart').textContent = bbt(S.sel.start);
  $('#selEnd').textContent = bbt(S.sel.end);
  $('#selLen').textContent = bbt(S.sel.end - S.sel.start, true);
}
let statusTimer;
function status(msg) { const el = $('#status'); el.textContent = msg; clearTimeout(statusTimer); statusTimer = setTimeout(() => { el.textContent = T.playing ? (T.recording ? 'Recording…' : 'Playing') : 'Ready'; }, 4000); }
function updateTransportUI() {
  $('#tpPlay').classList.toggle('on', T.playing);
  $('#tpRec').classList.toggle('armed', T.recArmed && !T.recording);
  $('#tpRec').classList.toggle('on', T.recording);
  $('#tpLoop').classList.toggle('on', S.loop);
  $('#tpClick').classList.toggle('on', S.click);
  $('#tpFollow').classList.toggle('on', S.follow);
  $$('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode));
  $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === S.tool));
  dirty();
}

// ───────────────────────── Menus ─────────────────────────
const isMac = navigator.platform.toUpperCase().includes('MAC');
const K = s => s.replace('Mod', isMac ? '⌘' : 'Ctrl').replace('Alt', isMac ? '⌥' : 'Alt');
const MENUS = {
  file: () => [
    { label: 'New Session (empty)', action: newSession },
    { label: 'Load Demo Session', action: () => { newSession(true); } },
    { sep: true },
    { label: 'Import Audio…', k: K('Mod+Shift+I'), action: () => $('#fileIn').click() },
    { label: 'Bounce Mix to WAV…', k: K('Mod+Alt+B'), action: bounce },
    ...(window.PREPRO_FILE_ITEMS ? window.PREPRO_FILE_ITEMS() : []),
    { sep: true },
    { label: 'Rename Session…', action: () => openModal('Session Name', `<div class="row" style="grid-template-columns:80px 1fr"><label>Name</label><input type="text" id="snIn" value="${escapeHtml(S.name)}"></div>`, [{ label: 'Cancel' }, { label: 'OK', primary: true, action: () => { S.name = $('#snIn').value || S.name; $('#sessionName').textContent = S.name; } }]) },
  ],
  edit: () => [
    { label: 'Undo', k: K('Mod+Z'), action: undo },
    { label: 'Redo', k: K('Mod+Shift+Z'), action: redo },
    { sep: true },
    { label: 'Cut', k: K('Mod+X'), action: () => cmdCopy(true) },
    { label: 'Copy', k: K('Mod+C'), action: () => cmdCopy() },
    { label: 'Paste', k: K('Mod+V'), action: cmdPaste },
    { label: 'Clear', k: 'Delete', action: cmdDelete },
    { label: 'Duplicate', k: K('Mod+D'), action: cmdDuplicate },
    { sep: true },
    { label: 'Select All', k: K('Mod+A'), action: cmdSelectAll },
    { label: 'Separate Clip at Selection', k: K('Mod+E') + '  /  B', action: cmdSeparate },
  ],
  view: () => [
    { label: 'Zoom In', k: 'T', action: () => zoom(1.5) },
    { label: 'Zoom Out', k: 'R', action: () => zoom(1 / 1.5) },
    { label: 'Zoom to Session', action: zoomFit },
    { sep: true },
    { label: 'Clip List', checked: S.showClipList, action: () => { S.showClipList = !S.showClipList; $('#editWin').classList.toggle('no-clips', !S.showClipList); setTimeout(sizeCanvases, 0); } },
    { label: 'Track Height: Small', action: () => setHeights(56) },
    { label: 'Track Height: Medium', action: () => setHeights(96) },
    { label: 'Track Height: Large', action: () => setHeights(140) },
  ],
  track: () => [
    { label: 'New…', k: K('Mod+Shift+N'), action: newTrackDialog },
    { label: 'Duplicate Selected', action: duplicateTracks },
    { label: 'Delete Selected', action: deleteTracks },
    { sep: true },
    { label: 'Rename Selected…', action: () => { const t = selectedTracks()[0]; if (t) renameTrack(t); } },
    { label: 'Clear All Solos', action: () => { S.tracks.forEach(t => t.solo = false); applyAllMix(); renderHeaders(); renderMixer(); } },
    { label: 'Clear All Mutes', action: () => { S.tracks.forEach(t => t.mute = false); applyAllMix(); renderHeaders(); renderMixer(); } },
  ],
  clip: () => [
    { label: 'Rename Clip…', action: renameClipDialog },
    { label: 'Fade In / Out (10 ms)', action: () => quickFades(0.01) },
    { label: 'Fade In / Out (500 ms)', action: () => quickFades(0.5) },
    { label: 'Remove Fades', action: () => quickFades(0) },
    { label: 'Spot Selected Clip…', action: () => { const f = findClip([...S.selClips][0] || ''); f ? spotDialog(f.tr, f.c) : status('Select a clip with the Grabber first'); } },
  ],
  event: () => [
    { label: 'Tempo…', action: tempoDialog },
    { label: 'Add Marker at Playhead', k: 'M', action: cmdAddMarker },
    { label: 'Memory Locations…', action: memoryLocations },
  ],
  options: () => [
    { label: 'Loop Playback', k: 'L', checked: S.loop, action: toggleLoop },
    { label: 'Click / Metronome', k: 'C', checked: S.click, action: toggleClick },
    { label: 'Follow Playhead', checked: S.follow, action: () => { S.follow = !S.follow; updateTransportUI(); } },
    { label: 'Insertion Follows Playback', checked: S.insertionFollows, action: () => { S.insertionFollows = !S.insertionFollows; } },
  ],
  window: () => [
    { label: 'Edit', k: K('Mod+='), checked: S.view === 'edit', action: () => setView('edit') },
    { label: 'Mix', k: K('Mod+='), checked: S.view === 'mix', action: () => setView('mix') },
    { label: 'Memory Locations', action: memoryLocations },
  ],
  help: () => [
    { label: 'Keyboard Shortcuts', action: showShortcuts },
    { label: 'About PrePro', action: () => openModal('About PrePro', '<p>PrePro is a browser-based multitrack recording, editing and mixing workstation with the familiar Pro Tools-style workflow: Edit and Mix windows, Shuffle / Spot / Slip / Grid modes, the Smart Tool, inserts, record-enable, loop playback, markers and bounce to disk. Songs save in your browser or as .prepro files, and the AI assistant runs on your own AI account.</p>', [{ label: 'Close', primary: true }]) },
  ],
};
let openMenu = null;
function showDropdown(items, x, y) {
  const dd = $('#dropdown');
  dd.innerHTML = items.map((it, i) => it.sep ? '<div class="sep"></div>' : `<div class="item ${it.checked ? 'checked' : ''}" data-i="${i}"><span>${it.label}</span>${it.k ? `<span class="k">${it.k}</span>` : ''}</div>`).join('');
  dd.hidden = false;
  dd.style.left = Math.min(x, innerWidth - 260) + 'px'; dd.style.top = y + 'px';
  dd.onclick = e => { const it = e.target.closest('.item'); if (!it) return; const item = items[+it.dataset.i]; closeMenus(); item.action && item.action(); };
}
function closeMenus() { $('#dropdown').hidden = true; $$('.menu').forEach(m => m.classList.remove('open')); openMenu = null; }
$$('.menu').forEach(m => {
  m.addEventListener('mousedown', e => {
    e.stopPropagation();
    if (openMenu === m.dataset.menu) return closeMenus();
    closeMenus(); openMenu = m.dataset.menu; m.classList.add('open');
    const r = m.getBoundingClientRect(); showDropdown(MENUS[m.dataset.menu](), r.left, r.bottom);
  });
  m.addEventListener('mouseenter', () => { if (openMenu && openMenu !== m.dataset.menu) { closeMenus(); openMenu = m.dataset.menu; m.classList.add('open'); const r = m.getBoundingClientRect(); showDropdown(MENUS[m.dataset.menu](), r.left, r.bottom); } });
});
document.addEventListener('mousedown', e => { if (!e.target.closest('#dropdown') && !e.target.closest('.menu') && !e.target.closest('.slot')) closeMenus(); });

// ───────────────────────── Dialogs ─────────────────────────
function openModal(title, body, buttons) {
  const back = $('#modalBack'), m = $('#modal');
  m.className = 'modal';
  m.innerHTML = `<h3><span>${title}</span><button data-x aria-label="Close">✕</button></h3><div class="body">${body}</div>${buttons.length ? `<div class="foot">${buttons.map((b, i) => `<button data-b="${i}" class="${b.primary ? 'primary' : ''}">${b.label}</button>`).join('')}</div>` : ''}`;
  back.hidden = false;
  const close = () => { back.hidden = true; m.innerHTML = ''; };
  m.querySelector('[data-x]').onclick = close;
  m.querySelectorAll('[data-b]').forEach(btn => btn.onclick = () => { const b = buttons[+btn.dataset.b]; const r = b.action ? b.action() : undefined; if (r !== false) close(); });
  back.onmousedown = e => { if (e.target === back) close(); };
  m.onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { const p = buttons.findIndex(b => b.primary); if (p >= 0) m.querySelector(`[data-b="${p}"]`).click(); } e.stopPropagation(); };
  return m;
}
function newTrackDialog() {
  openModal('New Tracks', `<div class="row" style="grid-template-columns:90px 1fr"><label>Create</label><input type="number" id="ntN" min="1" max="16" value="1"></div>
    <div class="row" style="grid-template-columns:90px 1fr"><label>Type</label><select id="ntT"><option>Mono Audio Track</option><option>Stereo Audio Track</option><option value="drums">Drum Track (MIDI, PrePro Drums)</option><option value="synth">Instrument Track (MIDI, Synth)</option><option value="external">MIDI Out Track (external plug-in)</option></select></div>
    <div class="row" style="grid-template-columns:90px 1fr"><label>Name</label><input type="text" id="ntName" value="Audio"></div>`,
    [{ label: 'Cancel' }, { label: 'Create', primary: true, action: () => {
      const n = clamp(parseInt($('#ntN').value, 10) || 1, 1, 16), kind = $('#ntT').value;
      const isInst = ['drums', 'synth', 'external'].includes(kind);
      const base = $('#ntName').value.trim() === 'Audio' && isInst ? ({ drums: 'Drums', synth: 'Synth', external: 'MIDI Out' })[kind] : ($('#ntName').value.trim() || 'Audio');
      pushHistory();
      const made = []; for (let i = 0; i < n; i++) { const nm = n > 1 || base === 'Audio' ? base + ' ' + (S.tracks.length + 1) : base; made.push(isInst ? makeInstTrack(kind, nm) : newTrack(nm)); }
      S.sel.tracks = new Set(made.map(t => t.id));
      refreshAll(); status('Created ' + n + ' track' + (n > 1 ? 's' : ''));
    } }]);
  setTimeout(() => $('#ntN').select(), 20);
}
function duplicateTracks() {
  const trs = selectedTracks(); if (!trs.length) return status('Select a track first');
  pushHistory();
  for (const t of trs) {
    const d = newTrack(t.name + '.dup', { vol: t.vol, pan: t.pan, h: t.h, inserts: t.inserts.map(i => i && JSON.parse(JSON.stringify(i))) });
    d.clips = t.clips.map(c => ({ ...c, id: uid('clp') }));
    S.tracks.splice(S.tracks.indexOf(t) + 1, 0, S.tracks.pop());
    rewire(d);
  }
  refreshAll();
}
function deleteTracks() {
  const trs = selectedTracks(); if (!trs.length) return status('Select a track first');
  pushHistory();
  for (const t of trs) { destroyLiveChain(t.id); S.tracks = S.tracks.filter(x => x !== t); }
  S.sel.tracks.clear(); refreshAll(); status('Deleted ' + trs.length + ' track(s)');
}
function setHeights(h) { const trs = selectedTracks().length ? selectedTracks() : S.tracks; trs.forEach(t => t.h = h); sizeCanvases(); renderHeaders(); }
function renameClipDialog() {
  const f = findClip([...S.selClips][0] || ''); if (!f) return status('Select a clip with the Grabber first');
  openModal('Rename Clip', `<div class="row" style="grid-template-columns:80px 1fr"><label>Name</label><input type="text" id="rcIn" value="${escapeHtml(f.c.name)}"></div>`,
    [{ label: 'Cancel' }, { label: 'OK', primary: true, action: () => { pushHistory(); f.c.name = $('#rcIn').value || f.c.name; dirty(); renderClipList(); } }]);
}
function quickFades(len) {
  const ids = S.selClips.size ? [...S.selClips] : [];
  if (!ids.length) { for (const tr of selectedTracks()) for (const c of tr.clips) if (c.start < S.sel.end && c.start + c.dur > S.sel.start) ids.push(c.id); }
  if (!ids.length) return status('Select clips to fade');
  pushHistory();
  ids.forEach(id => { const f = findClip(id); const l = Math.min(len, f.c.dur / 2); f.c.fadeIn = l; f.c.fadeOut = l; });
  dirty(); status(len ? 'Applied fades' : 'Removed fades');
}
function memoryLocations() {
  const rows = S.markers.length ? S.markers.map((m, i) => `<div class="row" style="grid-template-columns:28px 1fr 120px 60px"><span style="color:#e7c83c">${i + 1}</span><span>${escapeHtml(m.name)}</span><span style="font-family:var(--mono);color:var(--lcd)">${bbt(m.t).trim()}</span><button data-go="${m.id}" style="background:#3a3e43;border:1px solid #111;border-radius:3px;padding:3px">Go</button></div>`).join('') : '<p>No markers yet. Press M during playback or double-click the Markers ruler.</p>';
  const m = openModal('Memory Locations', rows, [{ label: 'Close', primary: true }]);
  m.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { const mk = S.markers.find(x => x.id === b.dataset.go); setInsertion(mk.t); if (tToX(mk.t) < 0 || tToX(mk.t) > lanesW) S.scrollT = Math.max(0, mk.t - 1); $('#modalBack').hidden = true; });
}
function showShortcuts() {
  const k = [['Space', 'Play / Stop'], [K('Mod') + '+Space', 'Record'], ['Home / Enter', 'Return to zero'], ['End', 'Go to end'], ['← / →', 'Nudge cursor or clip'], ['L', 'Loop playback'], ['C', 'Click'], ['M', 'Add marker'],
    ['F1–F4', 'Shuffle / Spot / Slip / Grid'], ['F6 / F7 / F8', 'Trim / Selector / Grabber'], ['F10', 'Smart tool'], ['R / T', 'Zoom out / in'], ['B or ' + K('Mod') + '+E', 'Separate clip'], ['Delete', 'Clear selection'],
    [K('Mod') + '+C / X / V', 'Copy / Cut / Paste'], [K('Mod') + '+D', 'Duplicate'], [K('Mod') + '+Z', 'Undo'], [K('Mod') + '+=', 'Toggle Edit / Mix'], [K('Mod') + '+Shift+N', 'New track'], [K('Mod') + '+Shift+I', 'Import audio'],
    ['Alt+click Solo', 'Exclusive solo'], ['Ctrl/Alt+wheel', 'Zoom at mouse'], ['Shift+wheel', 'Scroll timeline'], ['Double-click fader', 'Reset to 0 dB']];
  openModal('Keyboard Shortcuts', `<div class="keys">${k.map(([a, b]) => `<kbd>${a}</kbd><span>${b}</span>`).join('')}</div>`, [{ label: 'Close', primary: true }]);
}
function newSession(demo) {
  stop();
  for (const t of S.tracks) destroyLiveChain(t.id);
  S.tracks = []; S.markers = []; buffers.clear(); trackCounter = 0;
  S.sel = { start: 0, end: 0, tracks: new Set() }; S.selClips.clear(); S.playhead = 0; S.scrollT = 0;
  history.undo = []; history.redo = [];
  if (demo) { setTempo(120); synthDemo(); } else { S.name = 'Untitled Session'; $('#sessionName').textContent = S.name; newTrack('Audio 1'); newTrack('Audio 2'); }
  refreshAll(); zoomFit();
}

// ───────────────────────── View switching & toolbar ─────────────────────────
function setView(v) {
  S.view = v;
  $('#editWin').hidden = v !== 'edit'; $('#mixWin').hidden = v !== 'mix';
  $('#btnEdit').classList.toggle('active', v === 'edit'); $('#btnMix').classList.toggle('active', v === 'mix');
  if (v === 'mix') renderMixer(); else { sizeCanvases(); }
}
$('#btnEdit').onclick = () => setView('edit');
$('#btnMix').onclick = () => setView('mix');
$$('.mode').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; updateTransportUI(); status(b.textContent + ' mode'); });
$$('.tool').forEach(b => b.onclick = () => { S.tool = b.dataset.tool; updateTransportUI(); });
$('#zoomIn').onclick = () => zoom(1.5);
$('#zoomOut').onclick = () => zoom(1 / 1.5);
$('#zoomFit').onclick = zoomFit;
$('#gridSel').onchange = e => { S.gridBeats = parseFloat(e.target.value); dirty(); };
$('#tempoIn').onchange = e => setTempo(parseFloat(e.target.value));
$('#tpPlay').onclick = () => play();
$('#tpStop').onclick = () => { if (!T.playing) { setInsertion(0); } stop(); };
$('#tpRec').onclick = () => { if (T.playing) { stop(); return; } T.recArmed = !T.recArmed; updateTransportUI(); status(T.recArmed ? 'Record armed. Press Play to start recording' : 'Record disarmed'); };
$('#tpStart').onclick = goStart;
$('#tpEnd').onclick = goEnd;
$('#tpRew').onclick = () => jump(-4 * beatSec());
$('#tpFf').onclick = () => jump(4 * beatSec());
$('#tpLoop').onclick = toggleLoop;
$('#tpClick').onclick = toggleClick;
$('#tpFollow').onclick = () => { S.follow = !S.follow; updateTransportUI(); };
function toggleLoop() { S.loop = !S.loop; updateTransportUI(); status(S.loop ? (S.sel.end - S.sel.start > 0.05 ? 'Loop playback on' : 'Loop on: make a timeline selection to loop') : 'Loop playback off'); if (T.playing) { stop(); play(); } }
function toggleClick() { S.click = !S.click; updateTransportUI(); }
function goStart() { const wasPlaying = T.playing; if (wasPlaying) stop(); setInsertion(0); S.scrollT = 0; if (wasPlaying) play(); }
function goEnd() { if (T.playing) stop(); const e = sessionEnd(); setInsertion(e); if (tToX(e) > lanesW) S.scrollT = Math.max(0, e - lanesW * 0.8 / S.pps); }
function jump(dt) { const wasPlaying = T.playing; const p = Math.max(0, currentPos() + dt); if (wasPlaying) stop(); setInsertion(p); if (wasPlaying) play(); }

// Keyboard
window.addEventListener('keydown', e => {
  if (!$('#modalBack').hidden) { if (e.key === 'Escape') $('#modalBack').hidden = true; return; }
  if (e.target.matches('input, select, textarea, [contenteditable="true"]')) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key;
  const run = (fn) => { e.preventDefault(); fn(); };
  if (k === ' ' && mod) return run(recordNow);
  if (k === ' ') return run(togglePlay);
  if (mod && (k === '=' || k === '+')) return run(() => setView(S.view === 'edit' ? 'mix' : 'edit'));
  if (mod && e.shiftKey && (k === 'z' || k === 'Z')) return run(redo);
  if (mod && (k === 'z' || k === 'Z')) return run(undo);
  if (mod && (k === 'y' || k === 'Y')) return run(redo);
  if (mod && e.shiftKey && (k === 'n' || k === 'N')) return run(newTrackDialog);
  if (mod && e.shiftKey && (k === 'i' || k === 'I')) return run(() => $('#fileIn').click());
  if (mod && e.altKey && (k === 'b' || k === 'B' || e.code === 'KeyB')) return run(bounce);
  if (mod && (k === 'c' || k === 'C')) return run(() => cmdCopy());
  if (mod && (k === 'x' || k === 'X')) return run(() => cmdCopy(true));
  if (mod && (k === 'v' || k === 'V')) return run(cmdPaste);
  if (mod && (k === 'd' || k === 'D')) return run(cmdDuplicate);
  if (mod && (k === 'a' || k === 'A')) return run(cmdSelectAll);
  if (mod && (k === 'e' || k === 'E')) return run(cmdSeparate);
  if (mod) return;
  switch (k) {
    case 'Delete': case 'Backspace': return run(cmdDelete);
    case 'Home': case 'Enter': return run(goStart);
    case 'End': return run(goEnd);
    case 'ArrowLeft': return run(() => cmdNudge(-1));
    case 'ArrowRight': return run(() => cmdNudge(1));
    case 'b': case 'B': return run(cmdSeparate);
    case 'l': case 'L': return run(toggleLoop);
    case 'c': case 'C': return run(toggleClick);
    case 'm': case 'M': return run(cmdAddMarker);
    case 't': case 'T': return run(() => zoom(1.5));
    case 'r': case 'R': return run(() => zoom(1 / 1.5));
    case 'F1': return run(() => { S.mode = 'shuffle'; updateTransportUI(); });
    case 'F2': return run(() => { S.mode = 'spot'; updateTransportUI(); });
    case 'F3': return run(() => { S.mode = 'slip'; updateTransportUI(); });
    case 'F4': return run(() => { S.mode = 'grid'; updateTransportUI(); });
    case 'F6': return run(() => { S.tool = 'trim'; updateTransportUI(); });
    case 'F7': return run(() => { S.tool = 'select'; updateTransportUI(); });
    case 'F8': return run(() => { S.tool = 'grab'; updateTransportUI(); });
    case 'F10': return run(() => { S.tool = 'smart'; updateTransportUI(); });
    case 'Escape': return run(() => { S.selClips.clear(); dirty(); });
  }
});

// ───────────────────────── Main loop ─────────────────────────
function refreshAll() {
  sizeCanvases(); renderHeaders(); renderClipList();
  if (S.view === 'mix') renderMixer();
  updateTransportUI(); updateCounters(); dirty();
}
let lastHs = -1;
function frame() {
  if (T.playing) {
    loopTick(); scheduleClicks();
    const p = currentPos();
    if (S.follow && !drag) {
      const x = tToX(p);
      if (x > lanesW - 30 || x < 0) { S.scrollT = Math.max(0, p - 20 / S.pps); }
    }
    needsDraw = true;
  }
  if (needsDraw && S.view === 'edit') {
    drawRuler(); drawLanes(); updateCounters();
    const v = Math.round(S.scrollT / scrollMax() * 1000);
    if (v !== lastHs) { hs.value = v; lastHs = v; }
    needsDraw = false;
  } else if (needsDraw) { updateCounters(); needsDraw = false; }
  updateMeters();
  requestAnimationFrame(frame);
}
new ResizeObserver(() => { sizeCanvases(); if (S.view === 'mix') $$('.strip').forEach(s => s._placeCap && s._placeCap()); }).observe(document.body);

// Boot
synthDemo();
history.undo = [];
refreshAll();
requestAnimationFrame(() => { sizeCanvases(); zoomFit(); });
S.sel.tracks = new Set();
updateTransportUI();
status('Demo session loaded. Press Space to play');
requestAnimationFrame(frame);
// resume audio on first gesture (autoplay policy)
['mousedown', 'keydown'].forEach(ev => window.addEventListener(ev, () => { if (ctx.state !== 'running') ctx.resume(); }, { once: true }));
