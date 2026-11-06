/* PrePro MIDI: Web MIDI input/output, instrument tracks (PrePro Drums sampler with a
   Roland TD-17 map, poly synth, external MIDI out for plug-ins such as Steven Slate Drums),
   MIDI recording, MIDI editor with velocity lane and quantize, and .mid import/export. */
'use strict';

// ───────────────────────── Drum map (Roland TD-17 defaults, GM compatible) ─────────────────────────
const DRUM_PADS = [
  { id: 'kick', name: 'Kick', notes: [36, 35], lvl: 1 },
  { id: 'snare', name: 'Snare', notes: [38], lvl: 0.9 },
  { id: 'snareRim', name: 'Snare Rim', notes: [40], lvl: 0.95 },
  { id: 'xstick', name: 'Cross-stick', notes: [37], lvl: 0.6 },
  { id: 'clap', name: 'Clap', notes: [39], lvl: 0.7 },
  { id: 'tom1', name: 'Tom 1', notes: [48], lvl: 0.85 },
  { id: 'tom1Rim', name: 'Tom 1 Rim', notes: [50], lvl: 0.85, base: 'tom1', rim: true },
  { id: 'tom2', name: 'Tom 2', notes: [45], lvl: 0.85 },
  { id: 'tom2Rim', name: 'Tom 2 Rim', notes: [47], lvl: 0.85, base: 'tom2', rim: true },
  { id: 'tom3', name: 'Tom 3 (Floor)', notes: [43, 41], lvl: 0.9 },
  { id: 'tom3Rim', name: 'Tom 3 Rim', notes: [58], lvl: 0.9, base: 'tom3', rim: true },
  { id: 'hhClosed', name: 'Hi-hat Closed', notes: [42], lvl: 0.45 },
  { id: 'hhClosedEdge', name: 'Hi-hat Closed Edge', notes: [22], lvl: 0.5, base: 'hhClosed', edge: true },
  { id: 'hhOpen', name: 'Hi-hat Open', notes: [46], lvl: 0.42 },
  { id: 'hhOpenEdge', name: 'Hi-hat Open Edge', notes: [26], lvl: 0.48, base: 'hhOpen', edge: true },
  { id: 'hhPedal', name: 'Hi-hat Pedal', notes: [44], lvl: 0.35 },
  { id: 'crash1', name: 'Crash 1', notes: [49], lvl: 0.5 },
  { id: 'crash1Edge', name: 'Crash 1 Edge', notes: [55], lvl: 0.55, base: 'crash1', edge: true },
  { id: 'crash2', name: 'Crash 2', notes: [57], lvl: 0.5, alt: true },
  { id: 'crash2Edge', name: 'Crash 2 Edge', notes: [52], lvl: 0.55, base: 'crash2', edge: true },
  { id: 'ride', name: 'Ride', notes: [51], lvl: 0.42 },
  { id: 'rideEdge', name: 'Ride Edge', notes: [59], lvl: 0.45, base: 'ride', edge: true },
  { id: 'rideBell', name: 'Ride Bell', notes: [53], lvl: 0.45 },
  { id: 'aux', name: 'Aux (Cowbell)', notes: [27, 56], lvl: 0.5 },
  { id: 'auxRim', name: 'Aux Rim', notes: [28], lvl: 0.5, base: 'aux', rim: true },
];
const PAD = Object.fromEntries(DRUM_PADS.map(p => [p.id, p]));
const CYMBALS = new Set(['crash1', 'crash1Edge', 'crash2', 'crash2Edge', 'ride', 'rideEdge', 'rideBell']);
const OPEN_HATS = new Set(['hhOpen', 'hhOpenEdge']);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = n => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 2); // Roland/Yamaha octave naming (C1 = 36)
function padForNote(tr, n) {
  const m = tr.inst?.map;
  if (m) return PAD[m[n]] || null;
  return DRUM_PADS.find(p => p.notes.includes(n)) || null;
}
const padNote = (tr, padId) => { const m = tr.inst?.map; if (m) { const k = Object.keys(m).find(k => m[k] === padId); if (k) return +k; } return PAD[padId].notes[0]; };

// ───────────────────────── Synthesized default kit ─────────────────────────
function jbiquad(d, type, f, q, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) { const x = d[i]; const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y; }
  return d;
}
const METAL = [2, 3, 4.16, 5.43, 6.79, 8.21];
function synthPad(id, sr) {
  const P = PAD[id]; const base = P.base || id;
  const lens = { kick: 0.7, snare: 0.5, xstick: 0.15, clap: 0.45, tom1: 0.9, tom2: 1, tom3: 1.2, hhClosed: 0.18, hhOpen: 1.1, hhPedal: 0.15, crash1: 3.2, crash2: 3.2, ride: 3, rideBell: 2.6, aux: 0.5, snareRim: 0.5 };
  const n = Math.floor((lens[base] || 0.6) * sr), d = new Float32Array(n);
  const rnd = () => Math.random() * 2 - 1;
  const fill = fn => { for (let i = 0; i < n; i++) d[i] = fn(i / sr, i); };
  const metal = (f0, t) => { let s = 0; for (const r of METAL) s += Math.sign(Math.sin(2 * Math.PI * f0 * r * t)); return s / 6; };
  switch (base) {
    case 'kick': { let ph = 0; fill(t => { const f = 48 + 120 * Math.exp(-t * 26) + 60 * Math.exp(-t * 220); ph += 2 * Math.PI * f / sr; return Math.tanh(1.6 * (Math.sin(ph) * Math.exp(-t * 5.5) + rnd() * Math.exp(-t * 400) * 0.35)); }); break; }
    case 'snare': case 'snareRim': {
      const nz = new Float32Array(n); for (let i = 0; i < n; i++) nz[i] = rnd(); jbiquad(nz, 'bp', 3800, 0.6, sr); jbiquad(nz, 'hp', 300, 0.7, sr);
      const rim = base === 'snareRim';
      fill((t, i) => Math.tanh((Math.sin(2 * Math.PI * 182 * t) * 0.7 + Math.sin(2 * Math.PI * 330 * t) * 0.35) * Math.exp(-t * (rim ? 24 : 20)) * (rim ? 1.3 : 1) + nz[i] * 2.6 * Math.exp(-t * (rim ? 13 : 15)) + (rim ? Math.sin(2 * Math.PI * 920 * t) * Math.exp(-t * 30) * 0.45 : 0)));
      break;
    }
    case 'xstick': fill(t => Math.sin(2 * Math.PI * 1700 * t) * Math.exp(-t * 90) + Math.sin(2 * Math.PI * 520 * t) * Math.exp(-t * 55) * 0.7 + rnd() * Math.exp(-t * 220) * 0.3); break;
    case 'clap': { const nz = new Float32Array(n); for (let i = 0; i < n; i++) nz[i] = rnd(); jbiquad(nz, 'bp', 1300, 1.1, sr); fill((t, i) => nz[i] * 2 * (t < 0.03 ? (Math.floor(t / 0.0095) % 1 === 0 ? Math.exp(-(t % 0.0095) * 300) : 0) : 0.6 * Math.exp(-(t - 0.03) * 13))); break; }
    case 'tom1': case 'tom2': case 'tom3': {
      const f0 = { tom1: 165, tom2: 118, tom3: 84 }[base]; let ph = 0;
      const nz = new Float32Array(n); for (let i = 0; i < n; i++) nz[i] = rnd(); jbiquad(nz, 'lp', 2400, 0.7, sr);
      fill((t, i) => { ph += 2 * Math.PI * f0 * (1 + 0.45 * Math.exp(-t * 14)) / sr; return Math.tanh(1.3 * (Math.sin(ph) * Math.exp(-t * 4.2) + nz[i] * 0.35 * Math.exp(-t * 28))); });
      break;
    }
    case 'hhClosed': case 'hhOpen': case 'hhPedal': {
      const dec = { hhClosed: 22, hhOpen: 2.4, hhPedal: 30 }[base];
      fill(t => (metal(40, t) * 0.8 + rnd() * 0.45) * Math.exp(-t * dec) * (base === 'hhPedal' ? Math.min(1, t / 0.004) : 1));
      jbiquad(d, 'hp', 7000, 0.7, sr); jbiquad(d, 'hp', 6000, 0.6, sr); break;
    }
    case 'crash1': case 'crash2': {
      const f0 = base === 'crash1' ? 61 : 54;
      fill(t => (metal(f0, t) * 0.55 + rnd() * 0.7) * Math.exp(-t * 1.5) * Math.min(1, t / 0.002));
      jbiquad(d, 'hp', 3800, 0.7, sr); jbiquad(d, 'lp', 14000, 0.6, sr); break;
    }
    case 'ride': fill(t => (metal(72, t) * 0.35 + rnd() * 0.25) * Math.exp(-t * 1.3) + Math.sin(2 * Math.PI * 4200 * t) * Math.exp(-t * 9) * 0.25); jbiquad(d, 'hp', 4500, 0.7, sr); break;
    case 'rideBell': fill(t => [[1, 1.4], [2.32, 1.1], [3.6, 0.8], [4.5, 0.6]].reduce((s, [r, a]) => s + Math.sin(2 * Math.PI * 780 * r * t) * Math.exp(-t * (2.2 / a)) * a, 0) * 0.4 + rnd() * Math.exp(-t * 40) * 0.2); break;
    case 'aux': fill(t => (Math.sign(Math.sin(2 * Math.PI * 545 * t)) + Math.sign(Math.sin(2 * Math.PI * 815 * t))) * Math.exp(-t * 11) * 0.5); jbiquad(d, 'bp', 1000, 1.2, sr); break;
    default: fill(t => rnd() * Math.exp(-t * 30));
  }
  // rims and edges: brighter, more attack
  if (P.rim) { for (let i = 0; i < Math.min(n, sr * 0.01); i++) d[i] += (Math.random() * 2 - 1) * (1 - i / (sr * 0.01)) * 0.8; }
  if (P.edge) { const c = d.slice(); jbiquad(c, 'hp', 2500, 0.7, sr); for (let i = 0; i < n; i++) d[i] = d[i] * 0.8 + c[i] * 0.9; }
  let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v));
  const g = pk ? 0.95 / pk : 1; for (let i = 0; i < n; i++) d[i] *= g;
  const fo = Math.floor(sr * 0.01); for (let i = 0; i < fo; i++) d[n - 1 - i] *= i / fo;
  return d;
}
const kitCache = new Map();
function defaultSample(id) {
  if (kitCache.has(id)) return kitCache.get(id);
  const sr = ctx.sampleRate, d = synthPad(id, sr), b = ctx.createBuffer(1, d.length, sr);
  b.getChannelData(0).set(d); kitCache.set(id, b); return b;
}
function sampleFor(tr, id) {
  const bid = tr.inst?.samples?.[id];
  if (bid && buffers.has(bid)) return buffers.get(bid).buffer;
  const base = PAD[id].base;
  if (base && tr.inst?.samples?.[base] && buffers.has(tr.inst.samples[base])) return buffers.get(tr.inst.samples[base]).buffer;
  return defaultSample(id);
}

// ───────────────────────── Synth presets ─────────────────────────
const SYNTHS = {
  bass: { name: 'Synth Bass', wave: 'sawtooth', detune: 0, sub: 0.7, cutoff: 380, env: 2200, fdec: 0.12, res: 6, a: 0.003, d: 0.25, s: 0.55, r: 0.08, lvl: 0.55 },
  sub: { name: 'Sub Bass', wave: 'sine', detune: 0, sub: 0, cutoff: 900, env: 0, fdec: 0.1, res: 0.7, a: 0.004, d: 0.3, s: 0.9, r: 0.08, lvl: 0.75 },
  keys: { name: 'Electric Keys', wave: 'triangle', detune: 4, sub: 0, cutoff: 2600, env: 2500, fdec: 0.4, res: 1, a: 0.003, d: 1.4, s: 0.2, r: 0.35, lvl: 0.45 },
  pad: { name: 'Warm Pad', wave: 'sawtooth', detune: 12, sub: 0, cutoff: 1400, env: 600, fdec: 1.2, res: 1.5, a: 0.4, d: 0.8, s: 0.8, r: 0.9, lvl: 0.28 },
  pluck: { name: 'Pluck', wave: 'square', detune: 5, sub: 0, cutoff: 700, env: 5200, fdec: 0.09, res: 4, a: 0.002, d: 0.22, s: 0, r: 0.2, lvl: 0.38 },
  lead: { name: 'Lead', wave: 'square', detune: 7, sub: 0, cutoff: 2600, env: 1800, fdec: 0.25, res: 3, a: 0.01, d: 0.3, s: 0.75, r: 0.18, lvl: 0.3 },
  strings: { name: 'Strings', wave: 'sawtooth', detune: 9, sub: 0, cutoff: 3000, env: 0, fdec: 0.5, res: 0.8, a: 0.25, d: 0.5, s: 0.85, r: 0.6, lvl: 0.25 },
};
function synthVoice(c, dest, inst, note, vel, when, dur) {
  const P = SYNTHS[inst.preset] || SYNTHS.bass, f = 440 * Math.pow(2, (note - 69) / 12), v = vel / 127;
  const g = c.createGain(), flt = c.createBiquadFilter();
  flt.type = 'lowpass'; flt.Q.value = P.res;
  const oscs = [];
  const mk = (type, freq, det, lvl) => { const o = c.createOscillator(), og = c.createGain(); o.type = type; o.frequency.value = freq; o.detune.value = det; og.gain.value = lvl; o.connect(og).connect(flt); oscs.push(o); };
  mk(P.wave, f, -P.detune, P.detune ? 0.5 : 0.8); if (P.detune) mk(P.wave, f, P.detune, 0.5); if (P.sub) mk('sine', f / 2, 0, P.sub);
  const amp = P.lvl * (0.25 + 0.75 * v * v);
  g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(amp, when + P.a);
  g.gain.setTargetAtTime(amp * P.s, when + P.a, Math.max(0.01, P.d / 3));
  const fc = Math.min(18000, P.cutoff * (0.6 + 0.6 * v)); flt.frequency.setValueAtTime(fc + P.env * v, when); flt.frequency.setTargetAtTime(fc, when + P.a, P.fdec);
  flt.connect(g).connect(dest);
  oscs.forEach(o => o.start(when));
  const voice = {
    oscs, released: false,
    release(t) { if (this.released) return; this.released = true; t = Math.max(t, when + 0.005); if (g.gain.cancelAndHoldAtTime) g.gain.cancelAndHoldAtTime(t); else g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, Math.max(0.01, P.r / 3)); oscs.forEach(o => { try { o.stop(t + P.r * 3 + 0.05); } catch (e) {} }); },
  };
  if (dur != null) voice.release(when + Math.max(0.02, dur));
  return voice;
}

// ───────────────────────── Drum voice ─────────────────────────
const openHatVoices = new WeakMap(); // ctx -> Map(trackId -> [voices])
const cymVoices = new Map();         // live cymbals for aftertouch choke: trackId:pad -> [gain]
function velCurve(v) {
  const x = clamp(v / 127, 0, 1), c = S.velCurve || 'normal';
  return c === 'soft' ? Math.pow(x, 0.7) : c === 'hard' ? Math.pow(x, 2.2) : c === 'linear' ? x : Math.pow(x, 1.4);
}
function drumHit(c, dest, tr, n, when, gainMul = 1, collect = null) {
  let pad = padForNote(tr, n.n); if (!pad) return;
  const hh = n.hh ?? 0;
  if (OPEN_HATS.has(pad.id) && hh >= 100) pad = PAD[pad.edge ? 'hhClosedEdge' : 'hhClosed'];
  const buf = sampleFor(tr, pad.id);
  const lv = tr.inst.levels?.[pad.id] ?? 0, tune = tr.inst.tune?.[pad.id] ?? 0;
  const src = c.createBufferSource(); src.buffer = buf;
  src.playbackRate.value = Math.pow(2, tune / 12) * (1 + (Math.random() - 0.5) * 0.012);
  const v = velCurve(n.v);
  const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 1200 + 19000 * v * v; flt.Q.value = 0.5;
  const g = c.createGain(); g.gain.value = pad.lvl * v * dbToGain(lv) * gainMul * (1 + (Math.random() - 0.5) * 0.06);
  if (OPEN_HATS.has(pad.id) && hh > 0) g.gain.setTargetAtTime(0, when + 0.06 + 0.9 * (1 - hh / 127), 0.05);
  src.connect(flt).connect(g).connect(dest);
  src.start(when);
  if (collect) collect.push(src);
  // hi-hat choke
  let m = openHatVoices.get(c); if (!m) { m = new Map(); openHatVoices.set(c, m); }
  const list = m.get(tr.id) || []; m.set(tr.id, list);
  if (pad.id === 'hhClosed' || pad.id === 'hhClosedEdge' || pad.id === 'hhPedal') {
    for (const ov of list) if (ov.when < when) ov.g.gain.setTargetAtTime(0, when, 0.012);
    list.length = 0;
  } else if (OPEN_HATS.has(pad.id)) list.push({ g, when });
  if (list.length > 32) list.splice(0, list.length - 32);
  if (c === ctx && CYMBALS.has(pad.id)) { const k = tr.id + ':' + (pad.base || pad.id); const a = cymVoices.get(k) || []; a.push(g); if (a.length > 8) a.shift(); cymVoices.set(k, a); }
}

// ───────────────────────── Instrument tracks ─────────────────────────
function makeInstTrack(type = 'drums', name) {
  const t = newTrack(name || ({ drums: 'Drums', synth: 'Synth', external: 'MIDI Out' })[type], { vol: type === 'drums' ? -4 : -6 });
  t.kind = 'inst';
  t.inst = { type, preset: type === 'synth' ? 'keys' : 'bass', ch: 0, map: null, samples: {}, levels: {}, tune: {}, midiOut: type === 'external' ? (S.lastMidiOut || '') : '', outCh: type === 'drums' || type === 'external' ? 10 : 1 };
  t.h = Math.max(t.h, 96);
  return t;
}
function instLabel(tr) {
  const i = tr.inst || {};
  const out = i.midiOut ? ' → ' + (midiPortName('out', i.midiOut) || 'MIDI Out') : '';
  return 'MIDI ' + (i.ch ? 'Ch ' + i.ch : 'Omni') + ' · ' + (i.type === 'drums' ? 'PrePro Drums' : i.type === 'synth' ? (SYNTHS[i.preset]?.name || 'Synth') : 'External') + out;
}
const isInst = tr => tr && tr.kind === 'inst';

// ───────────────────────── Scheduling (playback + bounce) ─────────────────────────
const outNotes = new Map(); // portId -> Set("ch:note")
function scheduleMidiClip(c, dest, tr, clip, uA, uB, w, isLive) {
  if (!tr.inst) return;
  const gm = clipLevel(clip);
  const internal = tr.inst.type !== 'external';
  const out = isLive && tr.inst.midiOut ? midiOutput(tr.inst.midiOut) : null;
  const och = (tr.inst.outCh || 10) - 1;
  for (const n of clip.notes || []) {
    const u = n.t - clip.offset; if (u < uA - 1e-6 || u >= uB) continue;
    const when = w + (u - uA);
    const dur = Math.max(0.01, Math.min(n.d || 0.1, clip.dur - u));
    if (internal) {
      if (tr.inst.type === 'drums') drumHit(c, dest, tr, n, when, gm, isLive ? T.sources : null);
      else { const vc = synthVoice(c, dest, tr.inst, n.n, Math.round(n.v * Math.min(1.5, gm)), when, dur); if (isLive) T.sources.push(...vc.oscs); }
    }
    if (out) {
      const vel = clamp(Math.round(n.v * Math.min(1, gm)), 1, 127);
      if (n.hh != null && (padForNote(tr, n.n)?.id || '').startsWith('hh')) out.send([0xB0 | och, 4, n.hh], ctxToPerf(when - 0.001));
      out.send([0x90 | och, n.n, vel], ctxToPerf(when));
      out.send([0x80 | och, n.n, 0], ctxToPerf(when + dur));
      const set = outNotes.get(tr.inst.midiOut) || new Set(); set.add(och + ':' + n.n); outNotes.set(tr.inst.midiOut, set);
    }
  }
}
function ctxToPerf(t) {
  try { const ts = ctx.getOutputTimestamp(); if (ts && ts.performanceTime) return ts.performanceTime + (t - ts.contextTime) * 1000; } catch (e) {}
  return performance.now() + (t - ctx.currentTime) * 1000;
}
function midiStopAll() {
  for (const [pid, set] of outNotes) {
    const o = midiOutput(pid); if (!o) continue;
    try { o.clear && o.clear(); } catch (e) {}
    for (const k of set) { const [ch, n] = k.split(':').map(Number); o.send([0x80 | ch, n, 0]); }
    for (let ch = 0; ch < 16; ch++) o.send([0xB0 | ch, 123, 0]);
  }
  outNotes.clear();
}

// ───────────────────────── Web MIDI access ─────────────────────────
const MIDI = { access: null, state: 'off', err: '', last: null, disabled: new Set(), hh: new Map(), sustain: new Map(), liveVoices: new Map(), listeners: new Set() };
async function midiEnsure(interactive = false) {
  if (MIDI.access) return true;
  if (!navigator.requestMIDIAccess) { MIDI.state = 'unsupported'; MIDI.err = 'This browser does not support Web MIDI. Use Chrome, Edge, Opera or Firefox on a computer (Safari does not support MIDI).'; updateMidiBtn(); if (interactive) status(MIDI.err); return false; }
  try {
    MIDI.state = 'asking'; updateMidiBtn();
    MIDI.access = await navigator.requestMIDIAccess({ sysex: false });
    MIDI.state = 'on';
    MIDI.access.onstatechange = e => { bindInputs(); updateMidiBtn(); if (e.port.state === 'connected' && e.port.type === 'input' && !MIDI.seen?.has(e.port.id)) status('MIDI device connected: ' + e.port.name); MIDI.listeners.forEach(f => f()); refreshHeadersSoon(); };
    bindInputs(); updateMidiBtn();
    const names = [...MIDI.access.inputs.values()].map(i => i.name);
    status(names.length ? 'MIDI ready: ' + names.join(', ') : 'MIDI ready. No MIDI inputs found yet: connect your TD-17 by USB.');
    return true;
  } catch (e) {
    MIDI.state = 'blocked';
    MIDI.err = window.top !== window ? 'MIDI is blocked in this embedded preview. Open PrePro in its own browser tab (published link) and allow MIDI when asked.' : 'MIDI permission was denied. Click the MIDI icon in the address bar and allow MIDI devices, then try again.';
    updateMidiBtn(); if (interactive) status(MIDI.err);
    return false;
  }
}
let hdrTimer = 0;
const refreshHeadersSoon = () => { clearTimeout(hdrTimer); hdrTimer = setTimeout(() => { renderHeaders(); }, 100); };
function bindInputs() {
  MIDI.seen = MIDI.seen || new Set();
  for (const inp of MIDI.access.inputs.values()) { MIDI.seen.add(inp.id); inp.onmidimessage = e => onMidi(inp, e); }
}
function midiOutput(id) { return MIDI.access?.outputs.get(id) || null; }
function midiPortName(kind, id) { const m = kind === 'out' ? MIDI.access?.outputs : MIDI.access?.inputs; return m?.get(id)?.name || ''; }

// Which tracks receive live MIDI: armed or monitoring instrument tracks; else the selected one; else the first.
function liveTargets(ch) {
  const insts = S.tracks.filter(t => isInst(t) && (!t.inst.ch || t.inst.ch === ch + 1));
  const hot = insts.filter(t => t.arm || t.inputMon);
  if (hot.length) return hot;
  const sel = insts.filter(t => S.sel.tracks.has(t.id));
  if (sel.length) return sel.slice(0, 1);
  return insts.slice(0, 1);
}
let promptShown = false;
function onMidi(inp, e) {
  if (MIDI.disabled.has(inp.id)) return;
  const [st, d1 = 0, d2 = 0] = e.data; if (st >= 0xF0) return; // ignore clock, sensing, sysex
  const type = st & 0xF0, ch = st & 0x0F;
  const ctxT = ctx.currentTime - Math.max(0, (performance.now() - e.timeStamp) / 1000);
  if (type === 0xB0 && d1 === 4) MIDI.hh.set(ch, d2);
  const isOn = type === 0x90 && d2 > 0, isOff = type === 0x80 || (type === 0x90 && d2 === 0);
  if (isOn || type === 0xB0 || type === 0xA0) { MIDI.last = { port: inp.name, type, ch, d1, d2, at: performance.now() }; flashMidi(); MIDI.listeners.forEach(f => f()); }
  const targets = liveTargets(ch);
  if (!targets.length) {
    if (isOn && !promptShown) { promptShown = true; offerDrumTrack(inp.name, ch); }
    return;
  }
  if (ctx.state !== 'running') ctx.resume();
  for (const tr of targets) {
    const dest = live.get(tr.id)?.input; if (!dest) continue;
    const i = tr.inst;
    // thru to external MIDI out
    const out = i.midiOut ? midiOutput(i.midiOut) : null;
    if (out && (isOn || isOff || type === 0xB0 || type === 0xA0)) { try { out.send([type | ((i.outCh || ch + 1) - 1), d1, d2]); } catch (err) {} }
    if (isOn) {
      const n = { n: d1, v: d2, hh: MIDI.hh.get(ch) ?? 0 };
      if (i.type === 'drums') drumHit(ctx, dest, tr, n, ctx.currentTime);
      else if (i.type === 'synth') { const k = tr.id + ':' + d1; MIDI.liveVoices.get(k)?.release(ctx.currentTime); MIDI.liveVoices.set(k, synthVoice(ctx, dest, i, d1, d2, ctx.currentTime)); }
      if (midiRec && midiRec.tracks.has(tr.id)) recNoteOn(tr, n, ctxT);
      else window.capMidi?.('on', tr, n, ctxT);
    } else if (isOff) {
      const k = tr.id + ':' + d1;
      if (i.type === 'synth') { if (MIDI.sustain.get(ch)) { (MIDI.held ||= new Set()).add(k); } else { MIDI.liveVoices.get(k)?.release(ctx.currentTime); MIDI.liveVoices.delete(k); } }
      if (midiRec && midiRec.tracks.has(tr.id)) recNoteOff(tr, d1, ctxT);
      else window.capMidi?.('off', tr, { n: d1 }, ctxT);
    } else if (type === 0xB0 && d1 === 64) {
      MIDI.sustain.set(ch, d2 >= 64);
      if (d2 < 64 && MIDI.held) { for (const k of MIDI.held) { MIDI.liveVoices.get(k)?.release(ctx.currentTime); MIDI.liveVoices.delete(k); } MIDI.held.clear(); }
    } else if (type === 0xA0 && d2 >= 64 && i.type === 'drums') {
      // TD-17 cymbal choke (polyphonic aftertouch)
      const pad = padForNote(tr, d1); if (pad) { const k = tr.id + ':' + (pad.base || pad.id); (cymVoices.get(k) || []).forEach(g => g.gain.setTargetAtTime(0, ctx.currentTime, 0.03)); cymVoices.set(k, []); }
      if (midiRec && midiRec.tracks.has(tr.id)) recNoteOff(tr, d1, ctxT, true);
    }
  }
}
function offerDrumTrack(port, ch) {
  const d = document.createElement('div'); d.className = 'midi-toast';
  d.innerHTML = `<div><b>MIDI detected</b><span>${escapeHtml(port)} on channel ${ch + 1}. Create a drum track to play it?</span></div><button class="primary">Create drum track</button><button data-x>Not now</button>`;
  document.body.appendChild(d);
  d.querySelector('.primary').onclick = () => { pushHistory(); const t = makeInstTrack(ch === 9 ? 'drums' : 'synth', ch === 9 ? 'Drums MIDI' : 'Keys MIDI'); S.sel.tracks = new Set([t.id]); refreshAll(); d.remove(); status('Play your pads: ' + t.name + ' is ready. Press R on the track to record.'); };
  d.querySelector('[data-x]').onclick = () => d.remove();
  setTimeout(() => d.remove(), 20000);
}

// ───────────────────────── MIDI recording ─────────────────────────
let midiRec = null;
function midiRecStart(tracks, from) {
  midiRec = tracks.length ? { tracks: new Set(tracks.map(t => t.id)), from, ctx0: ctx.currentTime + 0.08, notes: new Map(tracks.map(t => [t.id, []])), open: new Map() } : null;
  if (midiRec) midiEnsure();
}
const recTime = ctxT => midiRec.from + (ctxT - midiRec.ctx0) - (ctx.outputLatency || ctx.baseLatency || 0);
function recNoteOn(tr, n, ctxT) {
  const t = Math.max(midiRec.from, recTime(ctxT)); if (recTime(ctxT) < midiRec.from - 0.2) return;
  const note = { t: Math.max(0, t - midiRec.from), d: tr.inst.type === 'drums' ? 0.1 : 0.25, n: n.n, v: n.v };
  if (tr.inst.type === 'drums' && (padForNote(tr, n.n)?.id || '').startsWith('hh')) note.hh = n.hh;
  midiRec.notes.get(tr.id).push(note); midiRec.open.set(tr.id + ':' + n.n, note);
  dirty();
}
function recNoteOff(tr, nn, ctxT) {
  const k = tr.id + ':' + nn, note = midiRec.open.get(k); if (!note) return;
  const t = recTime(ctxT) - midiRec.from;
  if (tr.inst.type !== 'drums') note.d = Math.max(0.02, t - note.t);
  midiRec.open.delete(k);
}
function midiRecFinish(endPos) {
  if (!midiRec) return;
  const r = midiRec; midiRec = null;
  const made = [];
  for (const [tid, notes] of r.notes) {
    const tr = S.tracks.find(t => t.id === tid); if (!tr || !notes.length) continue;
    if (!made.length) pushHistory();
    tr.takes = (tr.takes || 0) + 1;
    const dur = Math.max(0.1, endPos - r.from);
    carveRange(tr, r.from, r.from + dur);
    const c = Object.assign(newMidiClip(notes, r.from, dur, tr.name.replace(/\s+/g, '_') + '_' + String(tr.takes).padStart(2, '0')), takeTag());
    tr.clips.push(c); sortClips(tr); made.push(tr.name + ' (' + notes.length + ' notes)');
  }
  if (made.length) { status('Recorded MIDI on ' + made.join(', ')); refreshAll(); }
  else if (r.tracks.size) status('No MIDI notes were played while recording');
}
function newMidiClip(notes, start, dur, name) {
  return { id: uid('clp'), type: 'midi', src: uid('mid'), bufId: null, notes: notes.sort((a, b) => a.t - b.t), start, offset: 0, dur, name, fadeIn: 0, fadeOut: 0 };
}
// clone notes before editing so split or duplicated clips do not share edits
function ownNotes(c) { c.notes = (c.notes || []).map(n => ({ ...n })); c.src = uid('mid'); }

// ───────────────────────── Drawing MIDI clips ─────────────────────────
function drawMidiNotes(g, c, tr, x0, x1, top, h, sel) {
  if (h < 8) return;
  const notes = (c.notes || []).filter(n => n.t >= c.offset && n.t < c.offset + c.dur);
  g.save(); g.beginPath(); g.rect(x0, top, x1 - x0, h); g.clip();
  const drums = tr.inst?.type !== 'synth';
  let rows, rowOf;
  if (drums) {
    const used = [...new Set(notes.map(n => padForNote(tr, n.n)?.base || padForNote(tr, n.n)?.id || 'n' + n.n))];
    const order = DRUM_PADS.map(p => p.id);
    rows = used.sort((a, b) => order.indexOf(b) - order.indexOf(a));
    rowOf = n => rows.indexOf(padForNote(tr, n.n)?.base || padForNote(tr, n.n)?.id || 'n' + n.n);
  } else {
    const ps = notes.map(n => n.n); const lo = Math.min(...ps, 60) - 1, hi = Math.max(...ps, 60) + 1;
    rows = { length: hi - lo + 1 }; rowOf = n => hi - n.n;
  }
  const rh = Math.max(1.5, Math.min(8, h / Math.max(1, rows.length)));
  const oy = top + (h - rh * rows.length) / 2;
  for (const n of notes) {
    const x = tToX(c.start + n.t - c.offset), w = drums ? Math.max(2, Math.min(5, S.pps * 0.03)) : Math.max(2, n.d * S.pps);
    const a = 0.35 + 0.65 * n.v / 127;
    g.fillStyle = c.muted ? '#8a9097' : sel ? `rgba(255,255,255,${a})` : shade(tr.color, 90) + Math.round(a * 255).toString(16).padStart(2, '0');
    g.fillRect(x, oy + rowOf(n) * rh, w, Math.max(1.5, rh - 1));
  }
  if (!notes.length) { g.fillStyle = '#ffffff55'; g.font = '10px Inter, sans-serif'; g.textBaseline = 'middle'; g.fillText('Empty MIDI clip: double-click to edit', Math.max(x0, 0) + 6, top + h / 2); }
  g.restore();
}

// ───────────────────────── Quantize ─────────────────────────
function quantizeClip(c, gridBeats, strength = 1, swing = 0, sel = null) {
  ownNotes(c);
  const g = gridBeats * beatSec();
  for (const n of c.notes) {
    if (sel && !sel.has(n)) continue;
    const tl = c.start + n.t - c.offset;
    let k = Math.round(tl / g), q = k * g;
    if (swing && k % 2 === 1) q += g * swing;
    n.t += (q - tl) * strength; if (n.t < 0) n.t = 0;
  }
  c.notes.sort((a, b) => a.t - b.t);
}
function quantizeDialog() {
  const list = (typeof targetClips === 'function' ? targetClips() : []).filter(x => x.c.type === 'midi');
  if (!list.length) return status('Select MIDI clips to quantize');
  openModal('Quantize MIDI', `<div class="row" style="grid-template-columns:120px 1fr"><label>Grid</label><select id="qGrid"><option value="1">1/4 note</option><option value="0.5">1/8 note</option><option value="0.25" selected>1/16 note</option><option value="0.125">1/32 note</option><option value="0.3333333">1/8 triplet</option><option value="0.1666667">1/16 triplet</option></select></div>
    <div class="row" style="grid-template-columns:120px 1fr"><label>Strength</label><select id="qStr"><option value="1">100%</option><option value="0.75">75%</option><option value="0.5">50%</option><option value="0.25">25%</option></select></div>
    <div class="row" style="grid-template-columns:120px 1fr"><label>Swing</label><select id="qSw"><option value="0">0%</option><option value="0.17">Light (54%)</option><option value="0.33">Medium (58%)</option><option value="0.5">Heavy (62%)</option></select></div>`,
    [{ label: 'Cancel' }, { label: 'Quantize', primary: true, action: () => { pushHistory(); list.forEach(({ c }) => quantizeClip(c, +$('#qGrid').value, +$('#qStr').value, +$('#qSw').value)); dirty(); status('Quantized ' + list.length + ' MIDI clip' + (list.length > 1 ? 's' : '')); } }]);
}

// ───────────────────────── MIDI editor ─────────────────────────
function openMidiEditor(tr, c) {
  pushHistory(); const snap0 = JSON.stringify(c.notes || []);
  ownNotes(c);
  const drums = tr.inst?.type !== 'synth';
  const m = openModal(`MIDI Editor: ${escapeHtml(c.name)}`, `
    <div class="me-bar">
      <label>Grid <select id="meGrid"><option value="1">1/4</option><option value="0.5">1/8</option><option value="0.25" selected>1/16</option><option value="0.125">1/32</option><option value="0.3333333">1/8T</option><option value="0.1666667">1/16T</option></select></label>
      <label>New velocity <input type="range" id="meVel" min="1" max="127" value="100"><span id="meVelV">100</span></label>
      <button id="meQ" title="Quantize selected notes (or all)">Quantize</button>
      <select id="meQs" title="Quantize strength"><option value="1">100%</option><option value="0.75">75%</option><option value="0.5">50%</option></select>
      <button id="meZi" title="Zoom in">+</button><button id="meZo" title="Zoom out">−</button>
      <button id="mePlay">Play clip</button>
      <span class="me-help">Click to add · drag to move${drums ? '' : ' or set length'} · Alt+click or Delete removes · drag in the velocity lane</span>
    </div>
    <div class="me-wrap"><canvas id="meCv" tabindex="0"></canvas></div>`,
    [{ label: 'Done', primary: true, action: () => finish() }]);
  m.classList.add('modal-xl');
  const cv = $('#meCv'), wrap = cv.parentElement, g = cv.getContext('2d');
  const KEYW = 120, VELH = 70;
  let pps = 0, scroll = 0, selN = new Set(), dragS = null;
  // rows
  let rows;
  const buildRows = () => {
    if (drums) {
      const ids = DRUM_PADS.filter(p => !p.alt || c.notes.some(n => padForNote(tr, n.n) === p)).map(p => p.id).reverse();
      rows = ids.map(id => ({ label: PAD[id].name, note: padNote(tr, id), match: n => padForNote(tr, n.n)?.id === id }));
      const extra = [...new Set(c.notes.filter(n => !padForNote(tr, n.n)).map(n => n.n))];
      extra.forEach(nn => rows.unshift({ label: 'Note ' + nn + ' (' + noteName(nn) + ')', note: nn, match: n => n.n === nn }));
    } else {
      const ps = c.notes.map(n => n.n); const lo = Math.max(0, Math.min(...ps, 48) - 6), hi = Math.min(127, Math.max(...ps, 72) + 6);
      rows = []; for (let p = hi; p >= lo; p--) rows.push({ label: noteName(p), note: p, black: [1, 3, 6, 8, 10].includes(p % 12), match: n => n.n === p });
    }
  };
  buildRows();
  const RH = drums ? 20 : 13;
  const size = () => {
    const W = Math.min(window.innerWidth * 0.92, 1240) - 40, H = rows.length * RH + VELH + 24;
    const d = DPR(); cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = W * d; cv.height = H * d; g.setTransform(d, 0, 0, d, 0, 0);
    if (!pps) pps = (W - KEYW - 10) / Math.max(0.5, c.dur);
    cv._W = W; cv._H = H;
  };
  const gridB = () => +$('#meGrid').value;
  const tX = t => KEYW + (t - c.offset - scroll) * pps;              // t = note time in source seconds
  const xT = x => (x - KEYW) / pps + scroll + c.offset;
  const snapT = t => { const gsec = gridB() * beatSec(); const tl = c.start + t - c.offset; return Math.round(tl / gsec) * gsec - c.start + c.offset; };
  const rowY = i => 20 + i * RH;
  const rowOf = n => rows.findIndex(r => r.match(n));
  const draw = () => {
    const W = cv._W, H = cv._H, gy = 20 + rows.length * RH;
    g.clearRect(0, 0, W, H); g.fillStyle = '#1b1d20'; g.fillRect(0, 0, W, H);
    rows.forEach((r, i) => { g.fillStyle = r.black ? '#17191c' : i % 2 ? '#202327' : '#24272b'; g.fillRect(KEYW, rowY(i), W - KEYW, RH); });
    // grid
    const b = beatSec(), gsec = gridB() * b;
    g.fillStyle = '#2b2e32'; g.fillRect(0, 0, W, 20); g.fillStyle = '#25282c'; g.fillRect(0, gy, W, VELH + 4);
    const t0 = c.start - c.offset + c.offset + scroll, t1 = t0 + (W - KEYW) / pps;
    for (let k = Math.ceil((t0) / gsec); k * gsec <= t1; k++) {
      const tl = k * gsec, x = KEYW + (tl - t0) * pps, beatIdx = tl / b;
      const bar = Math.abs(beatIdx / 4 - Math.round(beatIdx / 4)) < 1e-6, beat = Math.abs(beatIdx - Math.round(beatIdx)) < 1e-6;
      g.fillStyle = bar ? '#5a6068' : beat ? '#3a3f45' : '#2c3035'; g.fillRect(Math.round(x), 20, 1, H - 20);
      if (bar) { g.fillStyle = '#aab1b8'; g.font = '10px Inter, sans-serif'; g.textBaseline = 'middle'; g.fillText(String(Math.round(beatIdx / 4) + 1), x + 3, 10); }
    }
    // clip end
    g.fillStyle = '#00000066'; const xe = tX(c.offset + c.dur); if (xe < W) g.fillRect(xe, 20, W - xe, H - 20);
    // notes
    for (const n of c.notes) {
      const i = rowOf(n); if (i < 0) continue;
      const x = tX(n.t), w = drums ? Math.max(6, Math.min(12, pps * 0.05)) : Math.max(3, n.d * pps);
      if (x + w < KEYW || x > W) continue;
      const v = n.v / 127, on = selN.has(n);
      g.fillStyle = on ? '#ffffff' : `hsl(${200 - v * 170}, 70%, ${40 + v * 22}%)`;
      if (drums) { g.beginPath(); g.moveTo(x, rowY(i) + RH / 2); g.lineTo(x + w / 2, rowY(i) + 2); g.lineTo(x + w, rowY(i) + RH / 2); g.lineTo(x + w / 2, rowY(i) + RH - 2); g.closePath(); g.fill(); }
      else { g.fillRect(x, rowY(i) + 1, w, RH - 2); g.strokeStyle = '#00000088'; g.strokeRect(x + .5, rowY(i) + 1.5, w - 1, RH - 3); }
      // velocity stalk
      const vx = x + (drums ? w / 2 : 1);
      g.fillStyle = on ? '#ffffff' : '#7fb2ff'; g.fillRect(vx - 1, gy + 4 + (VELH - 8) * (1 - v), 3, (VELH - 8) * v);
    }
    // keys column + header
    g.fillStyle = '#2b2e32'; g.fillRect(0, 0, KEYW, H);
    g.font = '11px Inter, sans-serif'; g.textBaseline = 'middle';
    rows.forEach((r, i) => { g.fillStyle = r.black ? '#16181b' : '#2f3337'; g.fillRect(0, rowY(i), KEYW - 2, RH - 1); g.fillStyle = r.black ? '#9aa1a8' : '#dfe3e7'; g.fillText(r.label + (drums ? '  ' + r.note : ''), 8, rowY(i) + RH / 2); });
    g.fillStyle = '#9aa1a8'; g.fillText('Velocity', 8, gy + VELH / 2);
    g.fillStyle = '#3a3f45'; g.fillRect(KEYW, gy, W - KEYW, 1);
  };
  const hit = (x, y) => {
    const i = Math.floor((y - 20) / RH); if (i < 0 || i >= rows.length) return null;
    return c.notes.find(n => { if (rowOf(n) !== i) return false; const nx = tX(n.t), w = drums ? Math.max(6, Math.min(12, pps * 0.05)) : Math.max(3, n.d * pps); return x >= nx - 2 && x <= nx + w + 2; });
  };
  const audition = n => { const dest = live.get(tr.id)?.input; if (!dest) return; if (ctx.state !== 'running') ctx.resume(); if (tr.inst.type === 'drums') drumHit(ctx, dest, tr, n, ctx.currentTime); else if (tr.inst.type === 'synth') synthVoice(ctx, dest, tr.inst, n.n, n.v, ctx.currentTime, 0.25); };
  cv.addEventListener('mousedown', e => {
    cv.focus();
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, gy = 20 + rows.length * RH;
    if (x < KEYW) { const i = Math.floor((y - 20) / RH); if (rows[i]) audition({ n: rows[i].note, v: +$('#meVel').value }); return; }
    if (y >= gy) { dragS = { kind: 'vel' }; velAt(x, y); return; }
    const n = hit(x, y);
    if (n && e.altKey) { c.notes = c.notes.filter(k => k !== n); selN.delete(n); draw(); dirty(); return; }
    if (n) {
      if (e.shiftKey) selN.has(n) ? selN.delete(n) : selN.add(n); else if (!selN.has(n)) selN = new Set([n]);
      const nx = tX(n.t), w = Math.max(3, n.d * pps);
      dragS = { kind: !drums && x > nx + w - 6 ? 'len' : 'move', x0: x, y0: y, items: [...selN].map(k => ({ k, t: k.t, n: k.n, d: k.d, ri: rowOf(k) })) };
      audition(n); draw(); return;
    }
    const i = Math.floor((y - 20) / RH); if (!rows[i]) return;
    const t = snapT(xT(x)); if (t < c.offset - 1e-6 || t >= c.offset + c.dur) return;
    const nn = { t: Math.max(0, t), d: drums ? 0.1 : gridB() * beatSec(), n: rows[i].note, v: +$('#meVel').value };
    c.notes.push(nn); c.notes.sort((a, b) => a.t - b.t); selN = new Set([nn]); audition(nn);
    dragS = { kind: drums ? 'move' : 'len', x0: x, y0: y, items: [{ k: nn, t: nn.t, n: nn.n, d: nn.d, ri: i }] };
    draw(); dirty();
  });
  const velAt = (x, y) => {
    const gy = 20 + rows.length * RH, v = clamp(Math.round((1 - (y - gy - 4) / (VELH - 8)) * 127), 1, 127);
    const cands = (selN.size ? [...selN] : c.notes).filter(n => Math.abs(tX(n.t) + 3 - x) < 6);
    cands.forEach(n => n.v = v); if (cands.length) { draw(); dirty(); }
  };
  const mv = e => {
    if (!dragS) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (dragS.kind === 'vel') return velAt(x, y);
    const gsec = gridB() * beatSec();
    if (dragS.kind === 'len') { for (const it of dragS.items) it.k.d = Math.max(gsec / 4, Math.round((it.d + (x - dragS.x0) / pps) / (gsec / 2)) * (gsec / 2) || gsec / 2); }
    else {
      const dt = Math.round(((x - dragS.x0) / pps) / gsec) * gsec, dr = Math.round((y - dragS.y0) / RH);
      for (const it of dragS.items) { it.k.t = clamp(it.t + dt, c.offset, c.offset + c.dur - 0.001); const ri = clamp(it.ri + dr, 0, rows.length - 1); it.k.n = rows[ri].note; }
    }
    draw(); dirty();
  };
  const up = () => { if (dragS) { c.notes.sort((a, b) => a.t - b.t); dragS = null; } };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  cv.addEventListener('wheel', e => { e.preventDefault(); scroll = clamp(scroll + (e.deltaX || e.deltaY) / pps, 0, Math.max(0, c.dur - 0.25)); draw(); }, { passive: false });
  cv.addEventListener('keydown', e => {
    if (e.key === 'Delete' || e.key === 'Backspace') { c.notes = c.notes.filter(n => !selN.has(n)); selN.clear(); draw(); dirty(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { selN = new Set(c.notes); draw(); e.preventDefault(); }
    else if (e.key.toLowerCase() === 'q') { $('#meQ').click(); e.preventDefault(); }
  });
  $('#meVel').oninput = e => { $('#meVelV').textContent = e.target.value; if (selN.size) { selN.forEach(n => n.v = +e.target.value); draw(); dirty(); } };
  $('#meGrid').onchange = draw;
  $('#meQ').onclick = () => { const keep = c.notes; quantizeClip(c, gridB(), +$('#meQs').value, 0, selN.size ? selN : null); /* quantize cloned the notes; remap selection */ const map = new Map(keep.map((k, i) => [k, i])); selN = new Set([...selN].map(k => c.notes[map.get(k)]).filter(Boolean)); buildRows(); draw(); dirty(); status('Quantized'); };
  $('#meZi').onclick = () => { pps *= 1.5; draw(); };
  $('#meZo').onclick = () => { pps /= 1.5; draw(); };
  $('#mePlay').onclick = () => { if (T.playing) { stop(); $('#mePlay').textContent = 'Play clip'; return; } S.sel.start = S.sel.end = c.start; S.sel.tracks = new Set([tr.id]); play(); $('#mePlay').textContent = 'Stop'; };
  const finish = () => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    if (JSON.stringify(c.notes) === snap0) history.undo.pop();
    if (T.playing) stop();
    dirty();
  };
  m.querySelector('[data-x]').addEventListener('click', finish);
  size(); draw(); cv.focus();
}

// ───────────────────────── Standard MIDI files ─────────────────────────
function parseMidiFile(ab) {
  const dv = new DataView(ab); let p = 0;
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const v = dv.getUint32(p); p += 4; return v; }, u16 = () => { const v = dv.getUint16(p); p += 2; return v; }, u8 = () => dv.getUint8(p++);
  const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hl = u32(), fmt = u16(), ntr = u16(), div = u16(); p = 8 + hl;
  if (div & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const tracks = [], tempos = [];
  for (let ti = 0; ti < ntr && p < ab.byteLength - 8; ti++) {
    const id = str(4), len = u32(), end = p + len;
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, rs = 0, name = ''; const notes = [], open = new Map(); let hh = 0;
    while (p < end) {
      tick += vlq();
      let st = dv.getUint8(p);
      if (st & 0x80) { p++; if (st < 0xF0) rs = st; } else st = rs;
      if (st === 0xFF) { const ty = u8(), l = vlq(); if (ty === 0x51 && l === 3) tempos.push({ tick, mpq: (dv.getUint8(p) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p + 2) }); if (ty === 0x03 && !name) { for (let i = 0; i < l; i++) name += String.fromCharCode(dv.getUint8(p + i)); } p += l; continue; }
      if (st === 0xF0 || st === 0xF7) { p += vlq(); continue; }
      const ty = st & 0xF0, ch = st & 15;
      if (ty === 0xC0 || ty === 0xD0) { u8(); continue; }
      const a = u8(), b = u8();
      if (ty === 0xB0 && a === 4) hh = b;
      if (ty === 0x90 && b > 0) { const nn = { tick, dur: 0, n: a, v: b, ch, hh }; notes.push(nn); open.set(ch * 128 + a, nn); }
      else if (ty === 0x80 || (ty === 0x90 && b === 0)) { const nn = open.get(ch * 128 + a); if (nn) { nn.dur = tick - nn.tick; open.delete(ch * 128 + a); } }
    }
    p = end;
    if (notes.length) tracks.push({ name: name.trim(), notes });
  }
  return { fmt, div, tracks, tempo: tempos.length ? 60000000 / tempos[0].mpq : null };
}
function importMidiFile(file) {
  file.arrayBuffer().then(ab => {
    let mf; try { mf = parseMidiFile(ab); } catch (e) { return status('Could not read MIDI file: ' + e.message); }
    if (!mf.tracks.length) return status('That MIDI file has no notes');
    const ft = mf.tempo ? Math.round(mf.tempo * 100) / 100 : null;
    const go = useFile => {
      if (useFile && ft) setTempo(ft);
      const spb = beatSec();
      pushHistory();
      const at = S.sel.start, made = [];
      const selInst = selectedTracks().find(isInst);
      mf.tracks.forEach((t, i) => {
        const isDrum = t.notes.every(n => n.ch === 9) || /drum|kit|groove|beat/i.test(t.name + file.name);
        let tr = i === 0 && selInst && (selInst.inst.type === 'drums') === isDrum ? selInst : null;
        if (!tr) tr = makeInstTrack(isDrum ? 'drums' : 'synth', (t.name || file.name.replace(/\.midi?$/i, '')).slice(0, 28));
        const notes = t.notes.map(n => { const o = { t: n.tick / mf.div * spb, d: Math.max(0.02, (n.dur || mf.div / 8) / mf.div * spb), n: n.n, v: n.v }; if (isDrum && [42, 44, 46, 22, 26].includes(n.n)) o.hh = n.hh; return o; });
        const t0 = Math.min(...notes.map(n => n.t));
        const bars = Math.ceil((Math.max(...notes.map(n => n.t + (isDrum ? 0.1 : n.d))) + 1e-3) / (4 * spb));
        const startBar = Math.floor(t0 / (4 * spb));
        notes.forEach(n => n.t -= startBar * 4 * spb);
        const dur = Math.max(1, bars - startBar) * 4 * spb;
        carveRange(tr, at, at + dur);
        const c = newMidiClip(notes, at, dur, file.name.replace(/\.midi?$/i, '').replace(/\s+/g, '_').slice(0, 24) + (mf.tracks.length > 1 ? '_' + (i + 1) : ''));
        tr.clips.push(c); sortClips(tr); made.push(c.id);
      });
      S.selClips = new Set(made);
      refreshAll(); status('Imported ' + file.name + ' (' + mf.tracks.reduce((s, t) => s + t.notes.length, 0) + ' notes)');
    };
    if (ft && Math.abs(ft - S.tempo) > 0.01) openModal('Import MIDI', `<p><b>${escapeHtml(file.name)}</b> was written at ${ft} BPM. The session is at ${S.tempo} BPM.</p>`,
      [{ label: 'Keep session tempo (' + S.tempo + ')', action: () => go(false) }, { label: 'Use file tempo (' + ft + ')', primary: true, action: () => go(true) }]);
    else go(false);
  });
}
const midiFileIn = document.createElement('input');
midiFileIn.type = 'file'; midiFileIn.accept = '.mid,.midi,audio/midi'; midiFileIn.multiple = true; midiFileIn.hidden = true;
document.body.appendChild(midiFileIn);
midiFileIn.onchange = e => { [...e.target.files].forEach(importMidiFile); e.target.value = ''; };
window.addEventListener('drop', e => {
  const files = [...(e.dataTransfer?.files || [])], mids = files.filter(f => /\.midi?$/i.test(f.name));
  if (!mids.length) return;
  e.preventDefault(); e.stopPropagation();
  document.querySelector('.dragover')?.classList.remove('dragover');
  mids.forEach(importMidiFile);
}, true);

function exportMidi() {
  const bytes = midiFileBytes();
  if (!bytes) return status('There are no MIDI clips to export');
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (S.name || 'Song').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.mid';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  status('Exported ' + a.download);
}
// Standard MIDI file (type 1) of every instrument track, or null when there is no MIDI
function midiFileBytes() {
  const insts = S.tracks.filter(t => isInst(t) && t.clips.some(c => c.type === 'midi'));
  if (!insts.length) return null;
  const PPQ = 480, spb = beatSec();
  const vlq = v => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
  const chunk = (id, bytes) => [...id].map(c => c.charCodeAt(0)).concat([(bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255], bytes);
  const mpq = Math.round(60000000 / S.tempo);
  const tempoTrk = [0, 0xFF, 0x51, 3, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255, 0, 0xFF, 0x58, 4, 4, 2, 24, 8, 0, 0xFF, 0x2F, 0];
  const trks = insts.map(tr => {
    const ch = tr.inst.type === 'drums' ? 9 : 0, ev = [];
    for (const c of tr.clips) if (c.type === 'midi' && !c.muted) for (const n of c.notes) {
      const u = n.t - c.offset; if (u < 0 || u >= c.dur) continue;
      const on = Math.round((c.start + u) / spb * PPQ), off = Math.round((c.start + Math.min(c.dur, u + (n.d || 0.1))) / spb * PPQ);
      ev.push([on, 1, 0x90 | ch, n.n, clamp(n.v, 1, 127)], [Math.max(on + 1, off), 0, 0x80 | ch, n.n, 0]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const name = [...tr.name].map(c => c.charCodeAt(0) & 127);
    let bytes = [0, 0xFF, 0x03, name.length, ...name], last = 0;
    for (const [t, , s, a, b] of ev) { bytes.push(...vlq(t - last), s, a, b); last = t; }
    bytes.push(0, 0xFF, 0x2F, 0);
    return chunk('MTrk', bytes);
  });
  const all = [...chunk('MThd', [0, 1, 0, insts.length + 1, PPQ >> 8, PPQ & 255]), ...chunk('MTrk', tempoTrk), ...trks.flat()];
  return new Uint8Array(all);
}

// ───────────────────────── Instrument settings (kit, synth, MIDI out) ─────────────────────────
function instrumentDialog(tr) {
  tr = tr || selectedTracks().find(isInst) || S.tracks.find(isInst);
  if (!tr) return status('Create a Drum or Instrument track first (Track > New)');
  midiEnsure();
  const i = tr.inst;
  const outs = MIDI.access ? [...MIDI.access.outputs.values()] : [];
  const kitRows = () => DRUM_PADS.map(p => `<tr data-pad="${p.id}"><td>${p.name}</td><td><input type="number" class="pn" min="0" max="127" value="${padNote(tr, p.id)}" title="MIDI note"></td><td><button class="learn" title="Hit the pad on your kit to assign">Learn</button></td>
      <td class="smp">${i.samples?.[p.id] && buffers.has(i.samples[p.id]) ? escapeHtml(buffers.get(i.samples[p.id]).name) : '<span style="color:var(--text-faint)">Built-in</span>'}</td>
      <td><button class="ld">Load…</button>${i.samples?.[p.id] ? ' <button class="clr" title="Back to the built-in sound">✕</button>' : ''}</td>
      <td><input type="range" class="lv" min="-24" max="12" step="0.5" value="${i.levels?.[p.id] ?? 0}" title="Level (dB)"></td>
      <td><input type="range" class="tn" min="-12" max="12" step="0.5" value="${i.tune?.[p.id] ?? 0}" title="Tune (semitones)"></td><td><button class="au" title="Audition">▶</button></td></tr>`).join('');
  const m = openModal('Instrument: ' + escapeHtml(tr.name), `<div class="inst-dlg">
    <div class="ai-form-grid" style="grid-template-columns:150px 1fr">
      <label>Instrument</label><select id="inType"><option value="drums" ${i.type === 'drums' ? 'selected' : ''}>PrePro Drums (sampler)</option><option value="synth" ${i.type === 'synth' ? 'selected' : ''}>PrePro Synth</option><option value="external" ${i.type === 'external' ? 'selected' : ''}>External only (MIDI out)</option></select>
      <label class="syn-only">Synth sound</label><select id="inPreset" class="syn-only">${Object.entries(SYNTHS).map(([k, v]) => `<option value="${k}" ${k === i.preset ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
      <label>MIDI input channel</label><select id="inCh"><option value="0">All channels (omni)</option>${[...Array(16).keys()].map(k => `<option value="${k + 1}" ${i.ch === k + 1 ? 'selected' : ''}>Channel ${k + 1}${k === 9 ? ' (TD-17 default)' : ''}</option>`).join('')}</select>
      <label>Send MIDI to</label><select id="inOut"><option value="">Nothing (play PrePro sounds only)</option>${outs.map(o => `<option value="${o.id}" ${o.id === i.midiOut ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select>
      <label>Output channel</label><select id="inOch">${[...Array(16).keys()].map(k => `<option value="${k + 1}" ${(i.outCh || 10) === k + 1 ? 'selected' : ''}>Channel ${k + 1}</option>`).join('')}</select>
    </div>
    <p class="hint">${outs.length ? 'Use "Send MIDI to" with a virtual MIDI port (loopMIDI on Windows, IAC Driver on Mac) to drive Steven Slate Drums or any plug-in in a plug-in host. See Setup > MIDI Setup for the steps.' : 'No MIDI outputs found. To drive Steven Slate Drums, create a virtual MIDI port (loopMIDI on Windows, IAC Driver on Mac). See Setup > MIDI Setup.'}</p>
    <div class="drum-only"><h4 style="margin:12px 0 6px">Kit and pad map</h4>
      <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap"><button id="kitFolder">Load samples by file name…</button><button id="kitReset">Reset to TD-17 map</button><button id="kitClear">Use built-in sounds</button><span class="hint" style="margin:0;align-self:center">File names with kick, snare, rim, tom1, hat, crash, ride and so on map automatically.</span></div>
      <div class="kit-tbl"><table><thead><tr><th>Pad</th><th>Note</th><th></th><th>Sample</th><th></th><th>Level</th><th>Tune</th><th></th></tr></thead><tbody id="kitBody">${kitRows()}</tbody></table></div>
    </div></div>`, [{ label: 'Done', primary: true }]);
  m.classList.add('modal-xl');
  const sync = () => { const ty = $('#inType').value; m.querySelectorAll('.syn-only').forEach(e => e.style.display = ty === 'synth' ? '' : 'none'); m.querySelector('.drum-only').style.display = ty === 'drums' ? '' : 'none'; };
  const save = () => { i.type = $('#inType').value; i.preset = $('#inPreset').value; i.ch = +$('#inCh').value; i.midiOut = $('#inOut').value; i.outCh = +$('#inOch').value; if (i.midiOut) S.lastMidiOut = i.midiOut; renderHeaders(); renderMixer(); dirty(); };
  ['inType', 'inPreset', 'inCh', 'inOut', 'inOch'].forEach(id => $('#' + id).onchange = () => { save(); sync(); });
  sync();
  const setMap = (pid, note) => {
    if (!i.map) { i.map = {}; DRUM_PADS.forEach(p => { i.map[p.notes[0]] = p.id; p.notes.slice(1).forEach(n => { i.map[n] = p.id; }); }); }
    for (const k of Object.keys(i.map)) if (i.map[k] === pid) delete i.map[k];
    i.map[note] = pid;
  };
  const fileFor = pid => new Promise(res => { const f = document.createElement('input'); f.type = 'file'; f.accept = 'audio/*'; f.onchange = () => res(f.files[0]); f.click(); });
  const loadSample = async (pid, file) => { try { const buf = await ctx.decodeAudioData(await file.arrayBuffer()); i.samples[pid] = addBuffer(buf, file.name); } catch (e) { status('Could not decode ' + file.name); } };
  const bindKit = () => {
    m.querySelectorAll('#kitBody tr').forEach(row => {
      const pid = row.dataset.pad;
      row.querySelector('.pn').onchange = e => { setMap(pid, clamp(+e.target.value, 0, 127)); };
      row.querySelector('.learn').onclick = e => {
        const b = e.target; b.textContent = 'Hit pad…'; b.classList.add('on');
        const once = () => { if (MIDI.last?.type === 0x90 && performance.now() - MIDI.last.at < 500) { setMap(pid, MIDI.last.d1); row.querySelector('.pn').value = MIDI.last.d1; b.textContent = 'Learn'; b.classList.remove('on'); MIDI.listeners.delete(once); status(PAD[pid].name + ' → note ' + MIDI.last.d1); } };
        MIDI.listeners.add(once);
      };
      row.querySelector('.ld').onclick = async () => { const f = await fileFor(pid); if (!f) return; await loadSample(pid, f); $('#kitBody').innerHTML = kitRows(); bindKit(); };
      const clr = row.querySelector('.clr'); if (clr) clr.onclick = () => { delete i.samples[pid]; $('#kitBody').innerHTML = kitRows(); bindKit(); };
      row.querySelector('.lv').oninput = e => { (i.levels ||= {})[pid] = +e.target.value; };
      row.querySelector('.tn').oninput = e => { (i.tune ||= {})[pid] = +e.target.value; };
      row.querySelector('.au').onclick = () => { if (ctx.state !== 'running') ctx.resume(); drumHit(ctx, live.get(tr.id).input, tr, { n: padNote(tr, pid), v: 110 }, ctx.currentTime); };
    });
  };
  bindKit();
  $('#kitFolder').onclick = () => {
    const f = document.createElement('input'); f.type = 'file'; f.accept = 'audio/*'; f.multiple = true;
    f.onchange = async () => {
      const rules = [['hhOpenEdge', /open.*edge|edge.*open/], ['hhClosedEdge', /(closed|tight).*edge/], ['hhPedal', /pedal|foot|chick/], ['hhOpen', /open|hh.?o\b|oh\b/], ['hhClosed', /hat|hh|closed/],
        ['crash1Edge', /crash.?1.*edge/], ['crash2Edge', /crash.?2.*edge/], ['crash2', /crash.?2|china|splash/], ['crash1', /crash/], ['rideBell', /bell/], ['rideEdge', /ride.*(edge|crash)/], ['ride', /ride/],
        ['tom1Rim', /(tom.?1|hi.?tom|rack.?1).*rim/], ['tom2Rim', /(tom.?2|mid.?tom|rack.?2).*rim/], ['tom3Rim', /(tom.?3|floor|low.?tom).*rim/], ['tom1', /tom.?1|hi.?tom|rack.?1|high.?tom/], ['tom2', /tom.?2|mid.?tom|rack.?2/], ['tom3', /tom.?3|floor|low.?tom/],
        ['xstick', /cross|xstick|side.?stick|stick/], ['snareRim', /rim/], ['clap', /clap/], ['snare', /snare|snr|sd\b/], ['kick', /kick|bd\b|bass.?drum|kik/], ['aux', /cow|aux|perc|block/]];
      let n = 0;
      for (const file of f.files) { const nm = file.name.toLowerCase(); const r = rules.find(([, re]) => re.test(nm)); if (r) { await loadSample(r[0], file); n++; } }
      $('#kitBody').innerHTML = kitRows(); bindKit(); status('Mapped ' + n + ' of ' + f.files.length + ' samples to pads');
    };
    f.click();
  };
  $('#kitReset').onclick = () => { i.map = null; $('#kitBody').innerHTML = kitRows(); bindKit(); status('Pad map reset to Roland TD-17 defaults'); };
  $('#kitClear').onclick = () => { i.samples = {}; $('#kitBody').innerHTML = kitRows(); bindKit(); status('Using the built-in PrePro kit'); };
}

// ───────────────────────── MIDI Setup dialog ─────────────────────────
async function midiSetupDialog() {
  await midiEnsure(true);
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch (e) {}
  const ins = MIDI.access ? [...MIDI.access.inputs.values()] : [], outs = MIDI.access ? [...MIDI.access.outputs.values()] : [];
  const lat = Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000);
  const m = openModal('MIDI Setup', `<div class="inst-dlg">
    ${MIDI.state !== 'on' ? `<p class="warn">${escapeHtml(MIDI.err || 'MIDI is not enabled yet.')}</p>` : ''}
    <h4>MIDI inputs</h4>
    <div class="song-list">${ins.length ? ins.map(p => `<div class="song-row"><div><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.manufacturer || '')} · ${p.state}</small></div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-in="${p.id}" ${MIDI.disabled.has(p.id) ? '' : 'checked'}> Enabled</label><span></span></div>`).join('') : '<p>No MIDI inputs found. Connect the TD-17 with a USB cable, set SETUP > USB > USB Driver Mode to GENERIC if you have not installed the Roland driver, then click Rescan.</p>'}</div>
    <p id="midiMon" class="mon">Hit a pad to test: waiting for MIDI…</p>
    <h4>MIDI outputs (for external plug-ins)</h4>
    <div class="song-list">${outs.length ? outs.map(p => `<div class="song-row"><div><b>${escapeHtml(p.name)}</b><small>${p.state}</small></div><button data-test="${p.id}">Send test note</button><span></span></div>`).join('') : '<p>No MIDI outputs. Create a virtual MIDI port to reach Steven Slate Drums (steps below).</p>'}</div>
    <div class="ai-form-grid" style="grid-template-columns:150px 1fr;margin-top:10px">
      <label>Velocity curve</label><select id="velC">${['soft', 'normal', 'linear', 'hard'].map(k => `<option value="${k}" ${(S.velCurve || 'normal') === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select>
      <label>Audio input (record)</label><select id="audIn"><option value="">System default</option>${devs.map(d => `<option value="${d.deviceId}" ${S.audioIn === d.deviceId ? 'selected' : ''}>${escapeHtml(d.label || 'Input ' + d.deviceId.slice(0, 6))}</option>`).join('')}</select>
      <label>Audio latency</label><span>${lat ? lat + ' ms output latency' : 'Interactive (lowest the browser allows)'}</span>
    </div>
    <details class="ssd"><summary><b>Use Steven Slate Drums (or any VST/AU plug-in) with your TD-17</b></summary>
      <ol>
        <li>Create a virtual MIDI port: on Windows install the free loopMIDI and add a port named "PrePro"; on Mac open Audio MIDI Setup, Window > Show MIDI Studio, double-click IAC Driver and tick "Device is online".</li>
        <li>Open Steven Slate Drums in a plug-in host (for example the free Element or Cantabile Lite, or any DAW). Set its MIDI input to the virtual port and pick the "Roland TD-17" map in SSD's Map tab (or MIDI-learn each pad).</li>
        <li>In PrePro, create a Drum Track (Track > New, type Drum Track), open Track > Instrument Settings, set "Send MIDI to" the virtual port and the output channel to 10. Set Instrument to "External only" if you only want to hear SSD.</li>
        <li>Arm the track (R), play the TD-17, and press Record. PrePro records the MIDI and sends every hit, including hi-hat pedal position, to SSD live and on playback, so you can edit and quantize the performance and hear it through SSD.</li>
        <li>To print SSD audio into PrePro, route the host's output to a loopback audio device (BlackHole on Mac, VB-Cable on Windows), choose that device above as the audio input, and record it onto an audio track.</li>
      </ol></details>
  </div>`, [{ label: 'Rescan', action: () => { setTimeout(midiSetupDialog, 10); } }, { label: 'Done', primary: true }]);
  m.classList.add('modal-xl');
  m.querySelectorAll('[data-in]').forEach(c => c.onchange = () => { c.checked ? MIDI.disabled.delete(c.dataset.in) : MIDI.disabled.add(c.dataset.in); });
  m.querySelectorAll('[data-test]').forEach(b => b.onclick = () => { const o = midiOutput(b.dataset.test); if (!o) return; o.send([0x99, 38, 100]); o.send([0x89, 38, 0], performance.now() + 150); status('Sent snare (note 38, channel 10) to ' + o.name); });
  $('#velC').onchange = e => { S.velCurve = e.target.value; };
  $('#audIn').onchange = e => { S.audioIn = e.target.value; if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; } status('Audio input set. It will be used for the next recording.'); };
  const mon = () => {
    const el = $('#midiMon'); if (!el || !MIDI.last) return;
    const L = MIDI.last, tr = S.tracks.find(isInst);
    const pad = L.type === 0x90 && tr ? padForNote(tr, L.d1) : null;
    el.textContent = L.type === 0x90 ? `${L.port}: note ${L.d1} (${noteName(L.d1)}${pad ? ', ' + pad.name : ''}), velocity ${L.d2}, channel ${L.ch + 1}` : L.type === 0xB0 ? `${L.port}: controller ${L.d1} = ${L.d2}${L.d1 === 4 ? ' (hi-hat pedal)' : ''}, channel ${L.ch + 1}` : `${L.port}: aftertouch note ${L.d1} = ${L.d2} (cymbal choke)`;
    el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 120);
  };
  MIDI.listeners.add(mon);
  const obs = setInterval(() => { if ($('#modalBack').hidden || !$('#midiMon')) { MIDI.listeners.delete(mon); clearInterval(obs); } }, 500);
}

// ───────────────────────── Toolbar button, menus, double-click ─────────────────────────
const midiBtn = document.createElement('button');
midiBtn.id = 'btnMidi'; midiBtn.title = 'MIDI Setup: connect your drum kit or keyboard';
midiBtn.innerHTML = '<i class="midi-led"></i>MIDI';
document.querySelector('.ai-btn-wrap')?.prepend(midiBtn);
midiBtn.onclick = () => midiSetupDialog();
function updateMidiBtn() {
  const n = MIDI.access ? [...MIDI.access.inputs.values()].filter(i => i.state === 'connected').length : 0;
  midiBtn.classList.toggle('ready', MIDI.state === 'on' && n > 0);
  midiBtn.classList.toggle('bad', MIDI.state === 'blocked' || MIDI.state === 'unsupported');
  midiBtn.title = MIDI.state === 'on' ? (n ? 'MIDI: ' + [...MIDI.access.inputs.values()].map(i => i.name).join(', ') : 'MIDI on, no devices connected') : MIDI.err || 'MIDI Setup: connect your drum kit or keyboard';
}
let flashT = 0;
function flashMidi() { midiBtn.classList.add('hit'); clearTimeout(flashT); flashT = setTimeout(() => midiBtn.classList.remove('hit'), 90); }

const _tm = MENUS.track, _fm = MENUS.file, _em = MENUS.event;
MENUS.track = () => { const a = _tm(); const at = a.findIndex(x => x.label === 'Duplicate Selected'); a.splice(at, 0,
  { label: 'New Drum Track (MIDI)', action: () => { pushHistory(); const t = makeInstTrack('drums'); S.sel.tracks = new Set([t.id]); midiEnsure(); refreshAll(); status('Drum track ready: play your kit or double-click the empty lane after recording'); } },
  { label: 'New Instrument Track (Synth)', action: () => { pushHistory(); const t = makeInstTrack('synth'); S.sel.tracks = new Set([t.id]); midiEnsure(); refreshAll(); } },
  { label: 'New MIDI Out Track (external plug-in)', action: () => { pushHistory(); const t = makeInstTrack('external'); S.sel.tracks = new Set([t.id]); midiEnsure().then(() => instrumentDialog(t)); refreshAll(); } },
  { label: 'Instrument Settings…', k: K('Mod+Shift+K'), action: () => instrumentDialog() },
  { label: 'New Empty MIDI Clip', action: newEmptyMidiClip },
  { sep: true }); return a; };
MENUS.file = () => { const a = _fm(); const at = a.findIndex(x => x.label && x.label.startsWith('Bounce')); a.splice(at, 0, { label: 'Import MIDI…', action: () => midiFileIn.click() }, { label: 'Export MIDI…', action: exportMidi }); return a; };
MENUS.event = () => [..._em(), { sep: true }, { label: 'Quantize MIDI…', k: K('Alt+0'), action: quantizeDialog }, { label: 'MIDI Editor', k: K('Mod+Shift+M'), action: () => { const f = targetClips().find(x => x.c.type === 'midi'); f ? openMidiEditor(f.tr, f.c) : status('Select a MIDI clip first'); } }, { label: 'MIDI Setup…', action: midiSetupDialog }];
function newEmptyMidiClip() {
  const tr = selectedTracks().find(isInst); if (!tr) return status('Select a Drum or Instrument track first');
  pushHistory();
  const st = S.sel.start, dur = hasRange() ? S.sel.end - S.sel.start : 4 * 4 * beatSec();
  carveRange(tr, st, st + dur);
  const c = newMidiClip([], st, dur, tr.name.replace(/\s+/g, '_') + '_MIDI'); tr.clips.push(c); sortClips(tr);
  refreshAll(); openMidiEditor(tr, c);
}
lanes.addEventListener('dblclick', e => {
  const r = lanes.getBoundingClientRect(), h = hitTest(e.clientX - r.left, e.clientY - r.top);
  if (h.c && h.c.type === 'midi') { e.preventDefault(); openMidiEditor(h.tr, h.c); }
  else if (!h.c && isInst(h.tr)) { S.sel.tracks = new Set([h.tr.id]); S.sel.start = S.sel.end = snap(Math.max(0, h.t - (h.t % (4 * beatSec())))); newEmptyMidiClip(); }
});
// click the instrument line in a track header to open its settings
$('#trackHeaders').addEventListener('click', e => {
  const sub = e.target.closest('.th-sub'); if (!sub) return;
  const el = sub.closest('[data-id]'); const tr = el && S.tracks.find(t => t.id === el.dataset.id);
  if (isInst(tr)) { e.stopPropagation(); instrumentDialog(tr); }
});
window.addEventListener('keydown', e => {
  if (!$('#modalBack').hidden || e.target.matches('input, select, textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && e.code === 'KeyK') { e.preventDefault(); e.stopImmediatePropagation(); instrumentDialog(); }
  else if (mod && e.shiftKey && e.code === 'KeyM') { e.preventDefault(); e.stopImmediatePropagation(); const f = targetClips().find(x => x.c.type === 'midi'); f ? openMidiEditor(f.tr, f.c) : status('Select a MIDI clip first'); }
  else if (!mod && e.altKey && e.code === 'Digit0') { e.preventDefault(); e.stopImmediatePropagation(); quantizeDialog(); }
}, true);
// enable MIDI quietly if permission was already granted
try { navigator.permissions?.query({ name: 'midi' }).then(p => { if (p.state === 'granted') midiEnsure(); }).catch(() => {}); } catch (e) {}
updateMidiBtn();
