/* PrePro workflow tools, ideas taken from what engineers praise and ask for in Pro Tools:
   Capture (keep what you played before pressing Record), song sections, single-key trims,
   Send to Engineer (stems package), song versions and saved effect chains. */
'use strict';

const WF_ICON = {
  cap: '<span class="cap-dot"></span>',
  section: '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M4 3v14M4 4h10l-2.5 3.5L14 11H4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
};
const fileSafe = s => String(s || 'Song').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'Song';
const barSec = () => 4 * beatSec();
const barNum = t => String(bbt(t)).trim().split('|')[0].trim();

// ───────────────────────── Capture ─────────────────────────
// While the microphone is open, PrePro keeps the last 60 seconds in memory (never uploaded).
// MIDI is kept the same way. Capture turns what you just played into a clip.
const CAP_SECONDS = 60;
const CAP = { listening: false, node: null, src: null, sink: null, chunks: [], midi: [], passes: [], lastCapture: -1e9 };
const CAP_WORKLET = `class PreProCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.t0 = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.t0 = currentTime;
      this.buf.set(ch, this.n); this.n += ch.length;
      if (this.n >= 4096) { this.port.postMessage({ t0: this.t0, d: this.buf }, [this.buf.buffer]); this.buf = new Float32Array(4096); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('prepro-capture', PreProCapture);`;
let capWorkletReady = null;

function capChunk(t0, d) {
  let pk = 0; for (let i = 0; i < d.length; i += 4) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
  CAP.chunks.push({ t0, d, pk });
  const old = ctx.currentTime - CAP_SECONDS - 2;
  while (CAP.chunks.length && CAP.chunks[0].t0 < old) CAP.chunks.shift();
}
window.capMidi = (type, tr, n, t) => {
  CAP.midi.push({ type, trId: tr.id, n: n.n, v: n.v, hh: n.hh, t });
  const old = ctx.currentTime - CAP_SECONDS - 2;
  while (CAP.midi.length && CAP.midi[0].t < old) CAP.midi.shift();
  syncCapture();
};

async function startListening(quiet) {
  if (CAP.listening && CAP.src === micSource) return true;
  if (!micSource) { const ok = await ensureMic(); if (!ok) return false; }
  if (ctx.state !== 'running') await ctx.resume();
  try {
    if (!CAP.node) {
      if (ctx.audioWorklet && window.AudioWorkletNode && capWorkletReady !== false) {
        if (!capWorkletReady) capWorkletReady = (async () => {
          try { await ctx.audioWorklet.addModule('capture-worklet.js?v=20'); return true; } catch (e) {}
          try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAP_WORKLET], { type: 'application/javascript' }))); return true; } catch (e) {}
          return false;
        })();
        if (await capWorkletReady) {
          CAP.node = new AudioWorkletNode(ctx, 'prepro-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          CAP.node.port.onmessage = e => capChunk(e.data.t0, e.data.d);
        } else capWorkletReady = false;
      }
      if (!CAP.node) {
        CAP.node = ctx.createScriptProcessor(4096, 1, 1);
        CAP.node.onaudioprocess = e => capChunk(ctx.currentTime - 4096 / ctx.sampleRate, new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      CAP.sink = ctx.createGain(); CAP.sink.gain.value = 0;
      CAP.node.connect(CAP.sink).connect(ctx.destination);
    }
    if (CAP.src && CAP.src !== micSource) { try { CAP.src.disconnect(CAP.node); } catch (e) {} }
    micSource.connect(CAP.node); CAP.src = micSource;
    CAP.listening = true; CAP.chunks = [];
    syncCapture();
    if (!quiet) status('Capture is listening. PrePro keeps the last 60 seconds on this device. Play or sing, then tap Capture to keep it.');
    return true;
  } catch (e) { status('Capture could not start: ' + e.message); return false; }
}
function stopListening() {
  if (CAP.src && CAP.node) { try { CAP.src.disconnect(CAP.node); } catch (e) {} }
  CAP.listening = false; CAP.src = null; CAP.chunks = [];
  syncCapture(); status('Capture stopped listening. MIDI is still kept, because it never uses the microphone.');
}
// when the microphone opens for recording, Capture starts listening too (it can be switched off)
{ const _ensureMic = ensureMic;
  ensureMic = async function (...a) { const ok = await _ensureMic(...a); if (ok && PREF.get('captureAuto', !/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !CAP.listening) setTimeout(() => startListening(true), 0); return ok; }; }
// track each play pass so a capture during playback lands where you played it
{ const _play = play, _stop = stop;
  play = async function (...a) {
    const r = await _play(...a);
    if (T.playing && T.segs[0]) { const lr = loopRange(); CAP.passes.push({ ctx0: T.segs[0].ctxStart, t0: T.segs[0].tStart, rec: T.recording, loop: !T.recording && lr ? lr : null, end: null }); if (CAP.passes.length > 12) CAP.passes.shift(); }
    syncCapture(); return r;
  };
  stop = function (...a) { const p = CAP.passes[CAP.passes.length - 1]; if (T.playing && p && p.end == null) p.end = ctx.currentTime; const r = _stop(...a); syncCapture(); return r; };
}

const capAudioIn = (a, b, thr) => CAP.chunks.some(c => c.t0 + c.d.length / ctx.sampleRate > a && c.t0 < b && c.pk > thr);
const capMidiIn = (a, b) => CAP.midi.filter(e => e.t >= a && e.t <= b);
const CAP_THR = 0.025;

function capAudio(a, b) {   // samples between ctx times a and b
  const sr = ctx.sampleRate, parts = CAP.chunks.filter(c => c.t0 + c.d.length / sr > a && c.t0 < b);
  if (!parts.length) return null;
  const t0 = parts[0].t0, len = Math.round((parts[parts.length - 1].t0 + parts[parts.length - 1].d.length / sr - t0) * sr);
  const out = new Float32Array(len);
  for (const p of parts) { const o = Math.round((p.t0 - t0) * sr); if (o >= 0 && o < len) out.set(p.d.subarray(0, Math.min(p.d.length, len - o)), o); }
  const s = clamp(Math.round((a - t0) * sr), 0, len), e = clamp(Math.round((b - t0) * sr), s, len);
  return { t0: t0 + s / sr, data: out.subarray(s, e) };
}
function capSoundSpan(a, b) {   // first and last loud moment in the window
  const sr = ctx.sampleRate, loud = CAP.chunks.filter(c => c.t0 + c.d.length / sr > a && c.t0 < b);
  const mx = Math.max(0, ...loud.map(c => c.pk)), thr = Math.max(CAP_THR, mx * 0.08);
  const hot = loud.filter(c => c.pk > thr); if (!hot.length) return null;
  return [Math.max(a, hot[0].t0 - 0.3), Math.min(b, hot[hot.length - 1].t0 + hot[hot.length - 1].d.length / sr + 0.7)];
}

function audioTarget(start, end) {
  const armed = S.tracks.find(t => t.arm && t.kind !== 'inst');
  if (armed) return { tr: armed, replace: true };
  const sel = selectedTracks().find(t => t.kind !== 'inst');
  if (sel && !sel.clips.some(c => c.start < end && c.start + c.dur > start)) return { tr: sel, replace: false };
  return { tr: newTrack(S.simple ? nextIdeaName() : 'Capture ' + (S.tracks.filter(t => /^Capture \d+$/.test(t.name)).length + 1)), replace: false };
}

async function captureNow() {
  if (T.recording || counting) return status('You are recording already. Capture is for the moments before you press Record.');
  if (ctx.state !== 'running') await ctx.resume();
  const now = ctx.currentTime, lastPass = CAP.passes[CAP.passes.length - 1];
  const floor = Math.max(now - CAP_SECONDS, CAP.lastCapture);
  let win = null, pass = null;
  if (T.playing && lastPass && !lastPass.rec) { win = [Math.max(floor, lastPass.ctx0), now]; pass = lastPass; }
  else {
    const free = [Math.max(floor, lastPass?.end ?? -1e9), now];
    if (free[1] - free[0] > 0.2 && (capMidiIn(...free).some(e => e.type === 'on') || capAudioIn(...free, CAP_THR))) win = free;
    else if (lastPass && !lastPass.rec && lastPass.end && lastPass.end > floor) {
      const w = [Math.max(floor, lastPass.ctx0), lastPass.end];
      if (capMidiIn(...w).some(e => e.type === 'on') || capAudioIn(...w, CAP_THR)) { win = w; pass = lastPass; }
    }
  }
  if (!win) {
    if (!CAP.listening) { const ok = await startListening(); if (ok) tip('capture', 'Capture is on. The red dot means PrePro is keeping the last 60 seconds on this device. When you play something you like, tap <b>Capture</b> to keep it, even if you never pressed Record.', '#bigCap'); return; }
    return status('Nothing heard in the last minute. Play or sing, then tap Capture.');
  }
  // loop playback: keep the most recent time around the loop that has something in it
  if (pass && pass.loop) {
    const L = pass.loop[1] - pass.loop[0];
    for (let k = Math.floor((win[1] - pass.ctx0) / L); k >= 0; k--) {
      const a = Math.max(win[0], pass.ctx0 + k * L), b = Math.min(win[1], pass.ctx0 + (k + 1) * L);
      if (b > a && (capMidiIn(a, b).some(e => e.type === 'on') || capAudioIn(a, b, CAP_THR))) { win = [a, b]; pass = { ...pass, ctx0: pass.ctx0 + k * L }; break; }
    }
  }
  const outLat = (ctx.outputLatency || 0), inLat = outLat + (ctx.baseLatency || 0);
  // where things land: during playback, where you played them; otherwise at the play position
  let refCtx, refT;
  const midiEv = capMidiIn(...win), firstNote = midiEv.find(e => e.type === 'on');
  const span = CAP.listening ? capSoundSpan(...win) : null;
  if (pass) { refCtx = pass.ctx0; refT = pass.t0; }
  else {
    // the first thing you played lands on the play position; audio and MIDI stay in time with each other
    refT = S.sel.start;
    let refE = Math.min(span ? span[0] - (ctx.baseLatency || 0) : Infinity, firstNote ? firstNote.t : Infinity);
    if (!isFinite(refE)) refE = win[0];
    refCtx = refE - outLat;
  }
  pushHistory();
  nextTakeColor();
  const made = [];
  // audio
  if (span) {
    const a = pass ? win[0] : span[0], b = pass ? win[1] : span[1];
    const au = capAudio(a, b);
    if (au && au.data.length > ctx.sampleRate * 0.2) {
      const buf = ctx.createBuffer(1, au.data.length, ctx.sampleRate); buf.copyToChannel(au.data, 0);
      let start = refT + (au.t0 - refCtx) - inLat, off = 0;
      if (start < 0) { off = -start; start = 0; }
      const dur = buf.duration - off;
      if (dur > 0.1) {
        const { tr, replace } = audioTarget(start, start + dur);
        tr.takes = (tr.takes || 0) + 1;
        const name = tr.name.replace(/\s+/g, '_') + '_Capture_' + String(tr.takes).padStart(2, '0');
        if (replace) { if (typeof keepTakes === 'function') keepTakes([tr], start); carveRange(tr, start, start + dur); }
        tr.clips.push(Object.assign(newClip(addBuffer(buf, name), start, { offset: off, dur, name, fadeIn: 0.02, fadeOut: 0.05 }), takeTag()));
        sortClips(tr); made.push(tr.name + ' (' + dur.toFixed(1) + ' s of sound)');
      }
    }
  }
  // MIDI, one clip per instrument track that heard notes
  const byTrack = new Map();
  for (const e of midiEv) { if (!byTrack.has(e.trId)) byTrack.set(e.trId, []); byTrack.get(e.trId).push(e); }
  for (const [tid, evs] of byTrack) {
    const tr = S.tracks.find(t => t.id === tid); if (!tr || !evs.some(e => e.type === 'on')) continue;
    const pos = e => refT + (e.t - outLat - refCtx);
    const open = new Map(), notes = [];
    for (const e of evs) {
      if (e.type === 'on') { const nt = { t: pos(e), d: tr.inst?.type === 'drums' ? 0.1 : 0.25, n: e.n, v: e.v }; if (tr.inst?.type === 'drums' && (padForNote(tr, e.n)?.id || '').startsWith('hh')) nt.hh = e.hh; notes.push(nt); open.set(e.n, nt); }
      else { const nt = open.get(e.n); if (nt && tr.inst?.type !== 'drums') nt.d = Math.max(0.02, pos(e) - nt.t); open.delete(e.n); }
    }
    const t0 = Math.max(0, pass ? Math.floor(Math.min(...notes.map(n => n.t)) / barSec()) * barSec() : refT);
    const last = Math.max(...notes.map(n => n.t + n.d));
    const dur = Math.max(barSec(), Math.ceil((last - t0) / barSec() - 1e-6) * barSec());
    notes.forEach(n => { n.t = Math.max(0, n.t - t0); });
    if (typeof keepTakes === 'function') keepTakes([tr], t0);
    carveRange(tr, t0, t0 + dur);
    tr.takes = (tr.takes || 0) + 1;
    tr.clips.push(Object.assign(newMidiClip(notes, t0, dur, tr.name.replace(/\s+/g, '_') + '_Capture_' + String(tr.takes).padStart(2, '0')), takeTag()));
    sortClips(tr); made.push(tr.name + ' (' + notes.length + ' notes)');
  }
  CAP.lastCapture = win[1];
  if (!made.length) { history.undo.pop(); return status('That was too short to keep. Play a little longer, then tap Capture.'); }
  refreshAll();
  status('Captured on ' + made.join(', ') + '. Undo removes it.');
}

function syncCapture() {
  for (const b of [$('#bigCap'), $('#tpCap')]) {
    if (!b) continue;
    b.classList.toggle('listening', CAP.listening);
    b.title = CAP.listening ? 'Capture is listening: PrePro keeps the last 60 seconds on this device. Tap to keep what you just played (Shift+C).' : 'Capture: keep what you just played, even if you did not press Record (Shift+C). Tap once to start listening.';
  }
}
(() => {
  const bar = $('.creative-bar');
  if (bar) {
    const b = document.createElement('button'); b.id = 'bigCap'; b.className = 'pill icon cap-btn';
    b.innerHTML = WF_ICON.cap + '<span>Capture</span>'; b.onclick = captureNow;
    bar.insertBefore(b, $('#countInBtn'));
    const s = document.createElement('button'); s.id = 'bigSection'; s.className = 'pill icon';
    s.title = 'Mark a song section (Verse, Chorus, Bridge) at the play position';
    s.innerHTML = WF_ICON.section + '<span>Section</span>';
    s.onclick = () => { const r = s.getBoundingClientRect(); sectionMenu(r.left, r.bottom + 4); };
    bar.insertBefore(s, $('#bigTakes'));
  }
  const opts = $('.tp-opts');
  if (opts) { const c = document.createElement('button'); c.id = 'tpCap'; c.className = 'cap-btn'; c.innerHTML = WF_ICON.cap + 'CAPTURE'; c.onclick = captureNow; opts.appendChild(c); }
  syncCapture();
})();
setInterval(() => { if (CAP.listening && micSource && CAP.src !== micSource) startListening(true); }, 2000);

// ───────────────────────── Song sections ─────────────────────────
function sectionName(type, except) {
  const used = S.markers.filter(m => m !== except && _secKey(m.name).startsWith(_secKey(type))).length;
  return used ? type + ' ' + (used + 1) : type;
}
function sectionMenu(x, y) {
  const items = SECTION_TYPES.map(([k, col]) => ({ label: `<i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${col};margin-right:8px"></i>${k}`, action: () => addSection(k) }));
  items.push({ sep: true }, { label: 'All Sections…', action: memoryLocations });
  showDropdown(items, x, y);
}
function addSection(type, at) {
  let t = at ?? (T.playing ? currentPos() : S.sel.start);
  const bs = barSec(); t = Math.max(0, Math.round(t / bs) * bs);   // sections start on a bar
  pushHistory();
  let m = S.markers.find(k => Math.abs(k.t - t) < 0.05);
  if (m) { m.name = sectionName(type, m); m.color = null; }
  else { m = { id: uid('mk'), t, name: sectionName(type) }; S.markers.push(m); S.markers.sort((a, b) => a.t - b.t); }
  dirty();
  status(m.name + ' starts at bar ' + barNum(t) + '. Tap the coloured band on the ruler to select the whole section.');
  tip('sections', 'Your song now has sections. Tap a coloured band at the top of the timeline to select that whole section, then use <b>Loop</b> to practise it, or copy it. Drag a section flag to move it.', '#bigSection');
  return m;
}
function sectionDialog(m) {
  let pick = sectionType(m.name)?.[0] || null;
  const chips = SECTION_TYPES.map(([k, col]) => `<button data-sec="${k}" style="background:${col}" class="${pick === k ? 'sel' : ''}">${k}</button>`).join('');
  const md = openModal('Song Section', `<div class="row" style="grid-template-columns:80px 1fr"><label>Name</label><input type="text" id="mkIn" value="${escapeHtml(m.name)}" maxlength="40"></div>
    <div class="chips">${chips}</div>
    <p class="mic-small">Starts at bar ${barNum(m.t)} (${minsec(m.t)}). Tap a colour to make this a Verse, Chorus or another section.</p>`,
    [{ label: 'Delete', action: () => { pushHistory(); S.markers = S.markers.filter(x => x !== m); dirty(); status('Section removed'); } },
     { label: 'Move to play position', action: () => { pushHistory(); m.t = Math.max(0, S.playhead); S.markers.sort((a, b) => a.t - b.t); dirty(); } },
     { label: 'Select section', action: () => { selectSectionAt(m.t); } },
     { label: 'OK', primary: true, action: () => { const v = $('#mkIn').value.trim(); if (v && v !== m.name) { pushHistory(); m.name = v; } dirty(); } }]);
  md.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => {
    md.querySelectorAll('[data-sec]').forEach(x => x.classList.toggle('sel', x === b));
    $('#mkIn').value = sectionName(b.dataset.sec, m);
  });
}
renameMarker = sectionDialog;

// ───────────────────────── Single-key trims (Pro Tools keyboard focus) ─────────────────────────
// A trims the start to the cursor, S trims the end, D fades in to the cursor, G fades out from it, F makes fades on a selection.
function keyTrim(kind) {
  const t = S.sel.start;
  if (kind === 'fades') { if (S.sel.end - S.sel.start > 0.001 && typeof createFades === 'function') return createFades(); return status('Select across the clip edges, then press F to make fades'); }
  let list = [...S.selClips].map(findClip).filter(Boolean);
  if (!list.length) {
    const trs = selectedTracks().length ? selectedTracks() : S.tracks;
    trs.forEach(tr => tr.clips.forEach(c => { if (t > c.start + 0.005 && t < c.start + c.dur - 0.005) list.push({ tr, c }); }));
  }
  list = list.filter(({ c }) => !c.locked && t > c.start + 0.005 && t < c.start + c.dur - 0.005);
  if (!list.length) return status('Put the cursor inside a clip first');
  pushHistory();
  for (const { c } of list) {
    if (kind === 'trimL') { const d = t - c.start; c.start = t; c.offset += d; c.dur -= d; c.fadeIn = Math.min(Math.max(0, c.fadeIn - d), c.dur / 2); }
    else if (kind === 'trimR') { c.dur = t - c.start; c.fadeOut = Math.min(c.fadeOut, c.dur / 2); }
    else if (kind === 'fadeIn') c.fadeIn = Math.min(t - c.start, c.dur - (c.fadeOut || 0));
    else if (kind === 'fadeOut') c.fadeOut = Math.min(c.start + c.dur - t, c.dur - (c.fadeIn || 0));
  }
  dirty(); renderClipList();
  status(({ trimL: 'Trimmed start to cursor', trimR: 'Trimmed end to cursor', fadeIn: 'Fade in to cursor', fadeOut: 'Fade out from cursor' })[kind] + (list.length > 1 ? ' on ' + list.length + ' clips' : ''));
}
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || !$('#modalBack').hidden) return;
  const tg = e.target; if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
  if (e.shiftKey && e.code === 'KeyC') { e.preventDefault(); e.stopImmediatePropagation(); captureNow(); return; }
  if (e.shiftKey || e.repeat) return;
  const kind = ({ KeyA: 'trimL', KeyS: 'trimR', KeyD: 'fadeIn', KeyG: 'fadeOut', KeyF: 'fades' })[e.code];
  if (!kind) return;
  e.preventDefault(); e.stopImmediatePropagation(); keyTrim(kind);
}, true);
{ const _sc = showShortcuts;
  showShortcuts = function () {
    _sc();
    const k = $('#modal .keys'); if (!k) return;
    k.insertAdjacentHTML('beforeend', [['A / S', 'Trim clip start / end to cursor'], ['D / G', 'Fade in to cursor / fade out from cursor'], ['F', 'Create fades on selection'], ['Shift+C', 'Capture what you just played']].map(([a, b]) => `<kbd>${a}</kbd><span>${b}</span>`).join(''));
  }; }

// ───────────────────────── Send to Engineer ─────────────────────────
// One package any studio can open: every track as a WAV file from bar 1, a mix, a MIDI file and a read-me.
if (typeof FEATURE_TEXT !== 'undefined') FEATURE_TEXT.engineer = ['Send to Engineer', 'Send to Engineer packs every track as a studio WAV file that starts at bar 1, plus the tempo and your song sections, so an engineer can open your song in Pro Tools, Logic or any studio.'];

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {   // stored (no compression): audio does not shrink much, and this is fast on a phone
  const parts = [], central = []; let off = 0;
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(c.buffer, name);
    off += 30 + name.length + size;
  }
  const csize = central.reduce((s, p) => s + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
function wavBytes(buf, bits) {   // 16 or 24-bit PCM; identical left and right become one mono file
  let chs = [buf.getChannelData(0)];
  if (buf.numberOfChannels > 1) { const L = buf.getChannelData(0), R = buf.getChannelData(1); let same = true; for (let i = 0; i < L.length; i += 7) if (Math.abs(L[i] - R[i]) > 1e-5) { same = false; break; } if (!same) chs = [L, R]; }
  const nch = chs.length, len = buf.length, sr = buf.sampleRate, by = bits / 8, dl = len * nch * by;
  const u8 = new Uint8Array(44 + dl), v = new DataView(u8.buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dl, true); ws(8, 'WAVE'); ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * by, true); v.setUint16(32, nch * by, true); v.setUint16(34, bits, true); ws(36, 'data'); v.setUint32(40, dl, true);
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) {
    const s = Math.max(-1, Math.min(1, chs[c][i]));
    if (bits === 24) { const x = Math.round(s < 0 ? s * 8388608 : s * 8388607); u8[o] = x & 255; u8[o + 1] = (x >> 8) & 255; u8[o + 2] = (x >> 16) & 255; o += 3; }
    else { v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); o += 2; }
  }
  return { data: u8, mono: nch === 1 };
}
function scheduleTrack(off, tr, input, len) {
  for (const c of tr.clips) {
    const cs = c.start, ce = cs + c.dur; if (ce <= 0 || cs >= len) continue;
    const a = Math.max(0, cs), b = Math.min(len, ce), w = a, uA = a - cs;
    if (c.type === 'midi') { if (!c.muted) scheduleMidiClip(off, input, tr, c, uA, b - cs, w, false); continue; }
    const bd = buffers.get(c.bufId); if (!bd) continue;
    const src = off.createBufferSource(); src.buffer = bd.buffer;
    const g = off.createGain();
    g.gain.setValueAtTime(c.fadeIn > 0 && uA < c.fadeIn ? uA / c.fadeIn : 1, w);
    if (c.fadeIn > 0 && uA < c.fadeIn) g.gain.linearRampToValueAtTime(1, w + c.fadeIn - uA);
    if (c.fadeOut > 0) { const fo = ce - c.fadeOut; if (fo > w) g.gain.setValueAtTime(1, fo); g.gain.linearRampToValueAtTime(0, ce); }
    const cg = off.createGain(); cg.gain.value = clipLevel(c);
    src.connect(g).connect(cg).connect(input);
    src.start(w, c.offset + uA, b - a);
  }
}
async function renderStem(tr, len, sr, print) {
  const off = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  const obj = print ? tr : { ...tr, inserts: [null, null, null, null, null] };
  const ch = buildChain(off, obj, false);
  ch.fader.gain.value = print && isFinite(tr.vol) ? dbToGain(tr.vol) : 1; ch.pan.pan.value = print ? tr.pan : 0;
  ch.mute.connect(off.destination);
  scheduleTrack(off, tr, ch.input, len);
  return off.startRendering();
}
async function renderMix(len, sr) {
  const off = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  const m = buildChain(off, S.master, false); m.fader.gain.value = dbToGain(S.master.vol); m.pan.pan.value = 0; m.mute.connect(off.destination);
  for (const tr of S.tracks) { if (!audible(tr)) continue; const ch = buildChain(off, tr, false); ch.fader.gain.value = dbToGain(tr.vol); ch.pan.pan.value = tr.pan; ch.mute.connect(m.input); scheduleTrack(off, tr, ch.input, len); }
  return off.startRendering();
}
function engineerReadme(rows, opts, sr, len) {
  const bar = t => 'bar ' + barNum(t);
  const lines = [
    `PrePro song: ${S.name}`, `Sent: ${new Date().toLocaleString()}`, '',
    `Tempo: ${S.tempo} BPM, 4/4`, `Sample rate: ${sr} Hz, ${opts.bits}-bit WAV`, `Length: ${minsec(len, 2)}`, '',
    'HOW TO OPEN', 'Every file starts at bar 1 (0:00.000). Make a new session at the tempo above,',
    'then drag all the WAV files in together and place them at the very start.', '',
    opts.print ? 'Effects and volume are printed into each track (what the songwriter hears).' : 'Tracks are dry: no effects, faders at 0 dB, panned centre.', '',
    'TRACKS', ...rows.map(r => `  ${r.file}  ${r.mono ? 'mono' : 'stereo'}${r.muted ? '  (muted in the song)' : ''}${r.inserts ? '  effects: ' + r.inserts : ''}`), '',
  ];
  if (S.markers.length) lines.push('SECTIONS AND MARKERS', ...S.markers.map(m => `  ${m.name.padEnd(16)} ${bar(m.t).padEnd(16)} ${minsec(m.t)}`), '');
  if (opts.midi) lines.push('MIDI', '  ' + fileSafe(S.name) + '.mid holds the drum and instrument parts as MIDI notes (tempo included).', '');
  lines.push('Made with PrePro.');
  return lines.join('\r\n');
}
function sendToEngineerDialog() {
  if (typeof needPro === 'function' && needPro('engineer')) return;
  const end = sessionEnd(); if (!end) return status('Record something first, then send it to your engineer');
  const tracks = S.tracks.filter(t => t.clips.length);
  const hasMidi = S.tracks.some(t => isInst(t) && t.clips.some(c => c.type === 'midi'));
  const sr = ctx.sampleRate, len = end + 1;
  const est = bits => Math.max(1, (tracks.length + 1) * len * sr * (bits / 8) * 2 / 1048576);
  openModal('Send to Engineer', `<p>PrePro packs your song so any studio can open it: each track as its own WAV file, all starting at bar 1, plus the tempo and your song sections.</p>
    <label class="wf-check"><input type="checkbox" id="steFx" checked><span>Include my effects and volume<small>Turn this off to send clean, dry tracks. Many mix engineers prefer dry tracks plus your rough mix.</small></span></label>
    <label class="wf-check"><input type="checkbox" id="steMix" checked><span>Include my rough mix<small>A stereo file of the whole song as you hear it now.</small></span></label>
    ${hasMidi ? '<label class="wf-check"><input type="checkbox" id="steMidi" checked><span>Include the MIDI file<small>Your drum and keyboard parts as notes, so the studio can use its own drum sounds (for example Steven Slate Drums).</small></span></label>' : ''}
    <div class="row" style="grid-template-columns:110px 1fr"><label>Quality</label><select id="steBits"><option value="24">Studio, 24-bit (up to ${est(24).toFixed(0)} MB)</option><option value="16">Smaller, 16-bit (up to ${est(16).toFixed(0)} MB)</option></select></div>
    <p class="mic-small">${tracks.length} tracks, ${minsec(len, 0)} long, ${sr} Hz. Nothing is uploaded: the package is made on this device.</p>`,
    [{ label: 'Cancel' }, { label: 'Make the package', primary: true, action: () => { const o = { print: $('#steFx').checked, mix: $('#steMix').checked, midi: hasMidi && !!$('#steMidi')?.checked, bits: +$('#steBits').value }; setTimeout(() => buildEngineerPackage(o), 0); } }]);
}
async function buildEngineerPackage(opts) {
  stop();
  const sr = ctx.sampleRate, len = sessionEnd() + 1, tracks = S.tracks.filter(t => t.clips.length);
  const steps = tracks.length + (opts.mix ? 1 : 0);
  const md = openModal('Send to Engineer', '<p id="steMsg">Getting ready…</p><div class="wf-prog"><i id="steBar"></i></div>', []);
  md.querySelector('[data-x]').hidden = true;
  const prog = (i, msg) => { $('#steMsg').textContent = msg; $('#steBar').style.width = Math.round(i / steps * 100) + '%'; };
  const files = [], rows = [], base = fileSafe(S.name);
  try {
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i]; prog(i, `Preparing track ${i + 1} of ${tracks.length}: ${tr.name}`);
      await new Promise(r => setTimeout(r, 30));
      const out = await renderStem(tr, len, sr, opts.print);
      const w = wavBytes(out, opts.bits), file = String(i + 1).padStart(2, '0') + '_' + fileSafe(tr.name) + '.wav';
      files.push({ name: base + '/' + file, data: w.data });
      rows.push({ file, mono: w.mono, muted: tr.mute, inserts: opts.print ? tr.inserts.filter(Boolean).map(x => PLUG_PRO?.[x.type] || x.type).join(', ') : '' });
    }
    if (opts.mix) { prog(tracks.length, 'Preparing the rough mix'); await new Promise(r => setTimeout(r, 30)); const w = wavBytes(await renderMix(len, sr), opts.bits); files.push({ name: base + '/00_' + base + '_Rough_Mix.wav', data: w.data }); }
    if (opts.midi) { const mb = midiFileBytes(); if (mb) files.push({ name: base + '/' + base + '.mid', data: mb }); }
    files.push({ name: base + '/READ_ME.txt', data: new TextEncoder().encode(engineerReadme(rows, opts, sr, len)) });
    prog(steps, 'Packing…');
    const zip = makeZip(files), zipName = base + '_for_engineer.zip';
    const file = new File([zip], zipName, { type: 'application/zip' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const list = files.map(f => f.name.split('/').pop() + '  ' + fmtSize(f.data.length)).join('\n');
    const m2 = openModal('Your package is ready', `<p><b>${escapeHtml(zipName)}</b> (${fmtSize(zip.size)})</p><div class="wf-files">${escapeHtml(list)}</div>
      <p class="mic-small">${canShare ? 'Tap Share to send it by AirDrop, Mail or Messages, or to save it in Files.' : 'Tap Download to save it, then send it to your engineer.'} Large songs are best sent with a file service such as WeTransfer or Google Drive.</p>`,
      [{ label: 'Close' }, ...(canShare ? [{ label: 'Share…', action: () => { navigator.share({ files: [file], title: S.name, text: 'Tracks for ' + S.name + ' from PrePro' }).catch(() => {}); return false; } }] : []),
       { label: 'Download', primary: true, action: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = zipName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); return false; } }]);
    status('Package ready: ' + tracks.length + ' tracks');
    return m2;
  } catch (e) {
    openModal('Send to Engineer', `<p>Something went wrong while preparing the files: ${escapeHtml(e.message)}</p><p class="mic-small">If the song is long, try the smaller 16-bit option.</p>`, [{ label: 'Close', primary: true }]);
  }
}

// ───────────────────────── Song versions ─────────────────────────
// Every save keeps a version. Audio is stored once and shared between versions, so versions are small.
const VDB = { db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no storage'));
      const r = indexedDB.open('prepro-versions', 1);
      r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('versions', { keyPath: 'id' }).createIndex('song', 'songId'); db.createObjectStore('audio', { keyPath: 'key' }); };
      r.onsuccess = () => res(this.db = r.result); r.onerror = () => rej(r.error);
    });
  },
  async req(store, mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction(store, mode), q = fn(tx.objectStore(store)); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); },
  list(songId) { return this.req('versions', 'readonly', s => s.index('song').getAll(songId)).then(a => (a || []).sort((x, y) => y.created - x.created)); },
};
const vSig = meta => { const s = JSON.stringify({ ...meta, savedAt: 0, pps: 0 }); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ':' + s.length; };
let vLastAt = 0, vBusy = false;
async function saveVersion(label, kind = 'save', force = false) {
  if (!S.songId || !S.tracks.length || vBusy) return null;
  vBusy = true;
  try {
    const meta = projectJSON(), sig = vSig(meta), songId = S.songId;
    const list = await VDB.list(songId);
    if (!force && list[0] && list[0].sig === sig) { vLastAt = Date.now(); return null; }
    for (const b of meta.buffers) {
      const key = songId + '/' + b.id;
      const have = await VDB.req('audio', 'readonly', s => s.count(key));
      if (have) continue;
      const buf = buffers.get(b.id).buffer, chans = [];
      for (let c = 0; c < b.ch; c++) chans.push(buf.getChannelData(c));
      await VDB.req('audio', 'readwrite', s => s.put({ key, songId, chans }));
    }
    const v = { id: uid('ver') + '-' + Date.now(), songId, created: Date.now(), label, kind, sig, name: S.name, tracks: S.tracks.length, dur: sessionEnd(), meta: JSON.stringify(meta) };
    await VDB.req('versions', 'readwrite', s => s.put(v));
    vLastAt = v.created;
    await pruneVersions(songId, [v, ...list]);
    return v;
  } catch (e) { console.warn('version', e); return null; }
  finally { vBusy = false; }
}
async function pruneVersions(songId, list) {
  const keepN = 30, auto = list.filter(v => v.kind !== 'named');
  const drop = auto.slice(keepN); if (!drop.length) return;
  await VDB.req('versions', 'readwrite', s => drop.forEach(v => s.delete(v.id)));
  const keep = list.filter(v => !drop.includes(v)), used = new Set();
  keep.forEach(v => JSON.parse(v.meta).buffers.forEach(b => used.add(songId + '/' + b.id)));
  const keys = await VDB.req('audio', 'readonly', s => s.getAllKeys());
  const orphan = (keys || []).filter(k => k.startsWith(songId + '/') && !used.has(k));
  if (orphan.length) await VDB.req('audio', 'readwrite', s => orphan.forEach(k => s.delete(k)));
}
async function restoreVersion(v) {
  try {
    await saveVersion('Before going back', 'auto');
    const meta = JSON.parse(v.meta), bufs = new Map();
    for (const b of meta.buffers) {
      const rec = await VDB.req('audio', 'readonly', s => s.get(v.songId + '/' + b.id));
      if (!rec) throw new Error('part of the audio for this version is missing');
      const ab = ctx.createBuffer(b.ch, b.len, b.sr); rec.chans.forEach((d, c) => ab.getChannelData(c).set(d));
      bufs.set(b.id, { buffer: ab, name: b.name });
    }
    loadProject({ meta, bufs }, v.songId);
    await writeSong(true);
    status('Went back to the version from ' + new Date(v.created).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + '. Your newer work is kept as a version too.');
  } catch (e) { status('Could not open that version: ' + e.message); }
}
// save a version with each save; while auto-saving, keep one every 10 minutes
let libPutAt = 0;
Lib.put = (orig => function (r) { return orig.call(this, r).then(x => { libPutAt = Date.now(); return x; }); })(Lib.put);
{ const _writeSong = writeSong;
  writeSong = async function (silent, ...rest) {
    const before = libPutAt; const r = await _writeSong(silent, ...rest);
    if (libPutAt !== before && Lib.persistent) {
      if (!silent) saveVersion('Saved', 'save');
      else if (Date.now() - vLastAt > 10 * 60000) saveVersion('Auto-saved', 'auto');
    }
    return r;
  }; }
async function versionsDialog() {
  if (!S.songId) return openModal('Song Versions', '<p>Save your song first. After that, PrePro keeps a version every time you save, and one every 10 minutes while it saves by itself.</p>', [{ label: 'Close' }, { label: 'Save Song', primary: true, action: () => setTimeout(() => saveSong(), 0) }]);
  let list = [];
  try { list = await VDB.list(S.songId); } catch (e) { return openModal('Song Versions', '<p>This browser view does not allow PrePro to keep versions. Open PrePro in Safari or Chrome to use them.</p>', [{ label: 'Close', primary: true }]); }
  const when = t => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const rows = list.length ? list.map(v => `<div class="wf-row"><div><b>${v.kind === 'named' ? escapeHtml(v.label) : when(v.created)}</b><small>${v.kind === 'named' ? when(v.created) : escapeHtml(v.label)} · ${v.tracks} tracks · ${minsec(v.dur || 0, 0)}</small></div><button data-name="${v.id}">Name</button><button class="primary" data-open="${v.id}">Go back to this</button></div>`).join('')
    : '<p class="mic-small">No versions yet. One is kept each time you save.</p>';
  const md = openModal('Song Versions', `<p>Every save keeps a version of <b>${escapeHtml(S.name)}</b>. Go back to any of them. Your newest work is kept as a version first, so nothing is lost.</p>
    <div class="wf-add"><input type="text" id="verName" placeholder="Version name" maxlength="60"><button class="primary" id="verSave">Save version</button></div>
    <div class="wf-list">${rows}</div>`, [{ label: 'Close', primary: true }]);
  md.querySelector('#verSave').onclick = async () => {
    const name = $('#verName').value.trim() || 'Saved ' + when(Date.now());
    await writeSong(true);
    const v = await saveVersion(name, 'named', true);
    status(v ? 'Saved the version "' + name + '"' : 'Could not save a version here'); versionsDialog();
  };
  md.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { const v = list.find(x => x.id === b.dataset.open); $('#modalBack').hidden = true; restoreVersion(v); });
  md.querySelectorAll('[data-name]').forEach(b => b.onclick = async () => {
    const v = list.find(x => x.id === b.dataset.name); const n = prompt('Name this version', v.kind === 'named' ? v.label : ''); if (!n) return;
    v.label = n.trim(); v.kind = 'named'; await VDB.req('versions', 'readwrite', s => s.put(v)); versionsDialog();
  });
}

// ───────────────────────── Effect chains ─────────────────────────
const CHAIN_FACTORY = [
  { name: 'Clear Vocal', inserts: [['filter', { type: 'highpass', freq: 90, q: 0.7 }], ['comp', { threshold: -20, ratio: 3, attack: 8, release: 120, makeup: 4 }], ['eq', { low: -1.5, lowF: 200, mid: -2, midF: 400, q: 1, high: 3, highF: 9000 }], ['reverb', { decay: 1.6, predelay: 30, tone: 7000, mix: 14 }]] },
  { name: 'Warm Vocal', inserts: [['filter', { type: 'highpass', freq: 80, q: 0.7 }], ['eq', { low: 1.5, lowF: 160, mid: -2.5, midF: 3000, q: 1.2, high: -1, highF: 10000 }], ['comp', { threshold: -18, ratio: 2.5, attack: 12, release: 160, makeup: 3 }], ['reverb', { decay: 2.4, predelay: 25, tone: 5500, mix: 18 }]] },
  { name: 'Phone Demo Cleanup', inserts: [['filter', { type: 'highpass', freq: 120, q: 0.7 }], ['eq', { low: -1, lowF: 150, mid: -3, midF: 350, q: 1, high: 3, highF: 8000 }], ['comp', { threshold: -24, ratio: 3, attack: 10, release: 140, makeup: 5 }]] },
  { name: 'Acoustic Guitar', inserts: [['filter', { type: 'highpass', freq: 100, q: 0.7 }], ['eq', { low: -1, lowF: 150, mid: -3, midF: 300, q: 1, high: 2.5, highF: 10000 }], ['comp', { threshold: -16, ratio: 2.5, attack: 15, release: 150, makeup: 2 }], ['reverb', { decay: 1.4, predelay: 15, tone: 8000, mix: 12 }]] },
  { name: 'Electric Guitar', inserts: [['filter', { type: 'highpass', freq: 90, q: 0.7 }], ['eq', { low: -2, lowF: 150, mid: 2, midF: 1500, q: 0.9, high: 0, highF: 8000 }], ['delay', { time: 320, feedback: 20, tone: 4500, mix: 12 }]] },
  { name: 'Tight Bass', inserts: [['filter', { type: 'highpass', freq: 35, q: 0.7 }], ['comp', { threshold: -22, ratio: 4, attack: 15, release: 150, makeup: 4 }], ['eq', { low: 3, lowF: 90, mid: -2, midF: 300, q: 1, high: 0, highF: 6000 }]] },
  { name: 'Punchy Drums', inserts: [['comp', { threshold: -20, ratio: 4, attack: 20, release: 120, makeup: 3 }], ['eq', { low: 3, lowF: 80, mid: -2, midF: 400, q: 1, high: 2.5, highF: 9000 }], ['reverb', { decay: 1, predelay: 5, tone: 8000, mix: 10 }]] },
  { name: 'Lo-fi', inserts: [['filter', { type: 'bandpass', freq: 1500, q: 0.9 }], ['comp', { threshold: -24, ratio: 6, attack: 5, release: 80, makeup: 6 }], ['delay', { time: 180, feedback: 15, tone: 3000, mix: 15 }]] },
].map(c => ({ ...c, builtIn: true, inserts: c.inserts.map(([type, params]) => ({ type, bypass: false, params })) }));
const userChains = () => PREF.get('fxChains', []);
function applyChain(tr, chain) {
  pushHistory();
  const ins = chain.inserts.map(i => i && PLUGINS[i.type] ? { type: i.type, bypass: !!i.bypass, params: { ...defaultParams(i.type), ...JSON.parse(JSON.stringify(i.params || {})) } } : null);
  while (ins.length < 5) ins.push(null);
  tr.inserts = ins.slice(0, 5);
  // rebuild the plug-ins so the new settings are heard straight away
  const ch = live.get(tr.id); if (ch) ch.plugins.forEach((p, i) => { if (p) { try { p.output.disconnect(); } catch (e) {} ch.plugins[i] = null; } });
  rewire(tr); renderMixer(); refreshAll();
  status(tr.name + ' now uses the ' + chain.name + ' chain. Undo takes it back.');
}
function chainsDialog(trId) {
  const trs = S.tracks; if (!trs.length) return status('Make a track first');
  const tr = trs.find(t => t.id === trId) || selectedTracks()[0] || trs[0];
  const all = [...userChains().map(c => ({ ...c, builtIn: false })), ...CHAIN_FACTORY];
  const desc = c => c.inserts.filter(Boolean).map(i => PLUGINS[i.type]?.name || i.type).join(' → ');
  const rows = all.map((c, i) => `<div class="wf-row"><div><b>${escapeHtml(c.name)}${c.builtIn ? '<span class="wf-tag">Built in</span>' : ''}</b><small>${escapeHtml(desc(c))}</small></div>${c.builtIn ? '' : `<button data-del="${i}">Delete</button>`}<button class="primary" data-use="${i}">Use</button></div>`).join('');
  const md = openModal('Effect Chains', `<div class="row" style="grid-template-columns:70px 1fr"><label>Track</label><select id="chTrack">${trs.map(t => `<option value="${t.id}" ${t === tr ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select></div>
    <p class="mic-small">An effect chain is a set of effects with their settings, like "My vocal sound". Use one on the track above, or save the track's effects to use again on any song.</p>
    <div class="wf-list">${rows}</div>
    <div class="wf-add"><input type="text" id="chName" placeholder="Chain name" maxlength="40"><button id="chSave">Save this track's effects</button></div>`, [{ label: 'Close', primary: true }]);
  const cur = () => S.tracks.find(t => t.id === $('#chTrack').value);
  md.querySelectorAll('[data-use]').forEach(b => b.onclick = () => { applyChain(cur(), all[+b.dataset.use]); $('#modalBack').hidden = true; });
  md.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const c = all[+b.dataset.del]; PREF.set('fxChains', userChains().filter(x => x.name !== c.name)); chainsDialog(cur().id); });
  md.querySelector('#chSave').onclick = () => {
    const t = cur(), n = $('#chName').value.trim();
    if (!t.inserts.some(Boolean)) return status(t.name + ' has no effects yet. Add some in the Mix window first.');
    if (!n) { $('#chName').focus(); return status('Type a name for the chain first'); }
    const list = userChains().filter(x => x.name !== n);
    list.unshift({ name: n, inserts: JSON.parse(JSON.stringify(t.inserts)) });
    PREF.set('fxChains', list); status('Saved the chain "' + n + '". It is ready on every song.'); chainsDialog(t.id);
  };
}

// ───────────────────────── Menus ─────────────────────────
MENUS.file = (orig => () => { const a = orig(); const at = a.findIndex(x => x.label && x.label.startsWith('Bounce')); a.splice(at + 1, 0, { label: 'Send to Engineer…', action: sendToEngineerDialog }, { label: 'Song Versions…', action: versionsDialog }); return a; })(MENUS.file);
MENUS.event = (orig => () => [...orig(), { sep: true },
  { label: 'Capture What I Just Played', k: 'Shift+C', action: captureNow },
  CAP.listening ? { label: 'Capture: Stop Listening', action: stopListening } : { label: 'Capture: Start Listening', action: () => startListening() },
  { label: 'Start Listening When the Mic Opens', checked: PREF.get('captureAuto', !/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)), action: () => PREF.set('captureAuto', !PREF.get('captureAuto', !/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))) },
  { sep: true }, ...SECTION_TYPES.slice(0, 5).map(([k]) => ({ label: 'Add Section: ' + k, action: () => addSection(k) }))])(MENUS.event);
MENUS.track = (orig => () => [...orig(), { sep: true }, { label: 'Effect Chains…', action: () => chainsDialog() }])(MENUS.track);
MENUS.options = (orig => () => [...orig(), { label: 'Colour Takes Automatically', checked: PREF.get('takeColors', true), action: () => { PREF.set('takeColors', !PREF.get('takeColors', true)); dirty(); } }])(MENUS.options);
if (typeof MENU_FRIENDLY !== 'undefined') Object.assign(MENU_FRIENDLY, { 'Send to Engineer…': 'Send to My Engineer…', 'Song Versions…': 'Go Back to an Earlier Version…', 'Effect Chains…': 'Sound Presets (Effect Chains)…' });
