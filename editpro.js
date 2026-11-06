/* PrePro Edit Pro: the deep, Pro Tools-style editing toolkit.
   Clip gain, clip mute and lock, crossfades, heal, consolidate, trim to selection,
   insert silence, repeat, strip silence, time stretch (TCE), Tab to transient,
   nudge values, playlists with comping, and zoom to selection. */
'use strict';

// ───────────────────────── Helpers ─────────────────────────
S.nudge = 'b:0.25';
S.tabTransients = false;
function nudgeSec() {
  const [k, v] = S.nudge.split(':');
  return k === 'ms' ? +v / 1000 : +v * beatSec();
}
$('#nudgeSel').onchange = e => { S.nudge = e.target.value; status('Nudge value: ' + e.target.selectedOptions[0].textContent); e.target.blur(); };
$('#gridSel').addEventListener('change', e => e.target.blur());

const hasRange = () => S.sel.end - S.sel.start > 0.001;
const editTracks = () => (selectedTracks().length ? selectedTracks() : S.tracks);
// Clips the command applies to: Grabber-selected clips, else clips touched by the edit selection
function targetClips() {
  if (S.selClips.size) return [...S.selClips].map(findClip).filter(Boolean);
  const out = [];
  const a = S.sel.start, b = hasRange() ? S.sel.end : S.sel.start + 1e-6;
  for (const tr of selectedTracks()) for (const c of tr.clips) if (c.start < b && c.start + c.dur > a) out.push({ tr, c });
  return out;
}
const done = msg => { dirty(); renderClipList(); status(msg); };
const bufOf = c => buffers.get(c.bufId).buffer;

// ───────────────────────── Clip gain, mute, lock ─────────────────────────
function clipGainBy(delta) {
  const list = targetClips(); if (!list.length) return status('Select clips (Grabber) or make a selection first');
  pushHistory();
  list.forEach(({ c }) => { c.gain = clamp(Math.round(((c.gain || 0) + delta) * 10) / 10, -36, 36); });
  done('Clip gain ' + (list.length === 1 ? ((list[0].c.gain > 0 ? '+' : '') + list[0].c.gain.toFixed(1) + ' dB') : (delta > 0 ? '+' : '') + delta + ' dB on ' + list.length + ' clips'));
}
function clipGainDialog() {
  const list = targetClips(); if (!list.length) return status('Select clips (Grabber) or make a selection first');
  const cur = list[0].c.gain || 0;
  openModal('Clip Gain', `<p>Set the gain of ${list.length} clip${list.length > 1 ? 's' : ''} before the track fader and plug-ins. Shortcut: ${K('Mod+Shift')}+Up or Down changes it by 1 dB.</p>
    <div class="row" style="grid-template-columns:90px 1fr"><label>Gain (dB)</label><input type="number" id="cgIn" step="0.5" min="-36" max="36" value="${cur}"></div>`,
    [{ label: 'Reset to 0 dB', action: () => { pushHistory(); list.forEach(({ c }) => c.gain = 0); done('Clip gain reset'); } },
     { label: 'Cancel' },
     { label: 'Apply', primary: true, action: () => { const v = clamp(+$('#cgIn').value || 0, -36, 36); pushHistory(); list.forEach(({ c }) => c.gain = v); done('Clip gain ' + fmtDb(v) + ' dB'); } }]);
  setTimeout(() => $('#cgIn').select(), 20);
}
function toggleClipMute() {
  const list = targetClips(); if (!list.length) return status('Select clips first');
  pushHistory(); const m = !list.every(({ c }) => c.muted);
  list.forEach(({ c }) => c.muted = m);
  if (T.playing) { stop(); play(); }
  done(m ? 'Clip muted' : 'Clip unmuted');
}
function toggleClipLock() {
  const list = targetClips(); if (!list.length) return status('Select clips first');
  pushHistory(); const l = !list.every(({ c }) => c.locked);
  list.forEach(({ c }) => c.locked = l);
  done(l ? 'Clip locked: it cannot be moved or trimmed' : 'Clip unlocked');
}

// ───────────────────────── Fades & crossfades ─────────────────────────
// Like Pro Tools Create Fades: selection across a clip boundary makes a crossfade,
// a selection at a clip start makes a fade in, at a clip end a fade out.
function createFades() {
  if (!hasRange()) {
    if (S.selClips.size) return quickFades(0.01);
    return status('Select across a clip boundary (crossfade) or a clip start or end (fade)');
  }
  const a = S.sel.start, b = S.sel.end;
  pushHistory();
  let xf = 0, fi = 0, fo = 0;
  for (const tr of editTracks()) {
    sortClips(tr);
    const used = new Set();
    // crossfades at boundaries inside the selection
    for (let i = 0; i < tr.clips.length - 1; i++) {
      const L = tr.clips[i], R = tr.clips[i + 1], t = L.start + L.dur;
      if (Math.abs(R.start - t) > 0.002 || t <= a || t >= b || L.type === 'midi' || R.type === 'midi') continue;
      const half = Math.min(t - a, b - t);
      const extL = Math.min(half, bufOf(L).duration - (L.offset + L.dur));  // material after L
      const extR = Math.min(half, R.offset);                               // material before R
      const h = Math.max(0.001, Math.min(extL, extR));
      if (h <= 0.0015) continue;
      L.dur += h; L.fadeOut = 2 * h;
      R.start -= h; R.offset -= h; R.dur += h; R.fadeIn = 2 * h;
      L.xfade = R.id; used.add(L.id); used.add(R.id); xf++;
    }
    // fades in / out
    for (const c of tr.clips) {
      if (used.has(c.id) || c.type === 'midi') continue;
      const cs = c.start, ce = c.start + c.dur;
      if (cs >= a - 1e-6 && cs < b && ce > b) { c.fadeIn = Math.min(b - cs, c.dur - c.fadeOut); fi++; }
      else if (ce <= b + 1e-6 && ce > a && cs < a) { c.fadeOut = Math.min(ce - a, c.dur - c.fadeIn); fo++; }
    }
  }
  if (!xf && !fi && !fo) { history.undo.pop(); return status('No clip boundary, start or end inside the selection'); }
  done([xf && xf + ' crossfade' + (xf > 1 ? 's' : ''), fi && fi + ' fade in', fo && fo + ' fade out'].filter(Boolean).join(', ') + ' created');
}

// ───────────────────────── Heal, trim, consolidate ─────────────────────────
function healSeparation() {
  pushHistory(); let n = 0;
  const a = hasRange() ? S.sel.start - 0.002 : -Infinity, b = hasRange() ? S.sel.end + 0.002 : Infinity;
  for (const tr of editTracks()) {
    sortClips(tr);
    for (let i = 0; i < tr.clips.length - 1; i++) {
      const L = tr.clips[i], R = tr.clips[i + 1], t = L.start + L.dur;
      if (t < a || t > b) continue;
      if (L.bufId === R.bufId && (L.type !== 'midi' || L.src === R.src) && Math.abs(R.start - t) < 0.002 && Math.abs(L.offset + L.dur - R.offset) < 0.002 && (L.gain || 0) === (R.gain || 0) && !!L.muted === !!R.muted) {
        L.dur = R.start + R.dur - L.start; L.fadeOut = R.fadeOut; L.name = L.name.replace(/-\d+$/, '') || L.name;
        tr.clips.splice(i + 1, 1); i--; n++;
      }
    }
  }
  if (!n) { history.undo.pop(); return status('No separations to heal here'); }
  done('Healed ' + n + ' separation' + (n > 1 ? 's' : ''));
}
function trimToSelection() {
  if (!hasRange()) return status('Make a selection to trim clips to');
  pushHistory(); let n = 0;
  const a = S.sel.start, b = S.sel.end;
  for (const tr of selectedTracks()) {
    tr.clips = tr.clips.filter(c => c.start < b && c.start + c.dur > a);
    for (const c of tr.clips) {
      if (c.locked) continue;
      if (c.start < a) { const d = a - c.start; c.start = a; c.offset += d; c.dur -= d; c.fadeIn = Math.max(0, c.fadeIn - d); n++; }
      if (c.start + c.dur > b) { c.dur = b - c.start; c.fadeOut = Math.min(c.fadeOut, c.dur); n++; }
    }
  }
  done('Trimmed ' + n + ' clip edge' + (n === 1 ? '' : 's') + ' to the selection');
}
// Render a time range of a track (fades, clip gain, mutes) into one new buffer
function renderTrackRange(tr, a, b) {
  const sr = ctx.sampleRate, n = Math.max(1, Math.round((b - a) * sr));
  const chs = Math.max(1, ...tr.clips.filter(c => c.start < b && c.start + c.dur > a).map(c => bufOf(c).numberOfChannels));
  const out = ctx.createBuffer(chs, n, sr);
  for (const c of tr.clips) {
    if (c.muted || c.start >= b || c.start + c.dur <= a) continue;
    const src = bufOf(c), g = dbToGain(c.gain || 0), ratio = src.sampleRate / sr;
    const s = Math.max(a, c.start), e = Math.min(b, c.start + c.dur);
    for (let ch = 0; ch < chs; ch++) {
      const sd = src.getChannelData(Math.min(ch, src.numberOfChannels - 1)), od = out.getChannelData(ch);
      for (let i = Math.round((s - a) * sr), iEnd = Math.round((e - a) * sr); i < iEnd; i++) {
        const tl = a + i / sr, u = tl - c.start;
        let env = 1;
        if (c.fadeIn > 0 && u < c.fadeIn) env = u / c.fadeIn;
        if (c.fadeOut > 0 && u > c.dur - c.fadeOut) env = Math.min(env, (c.dur - u) / c.fadeOut);
        const si = Math.floor((c.offset + u) * src.sampleRate);
        if (si >= 0 && si < sd.length) od[i] += sd[si] * g * clamp(env, 0, 1);
      }
      void ratio;
    }
  }
  return out;
}
function consolidate() {
  let jobs = [];
  if (hasRange()) jobs = selectedTracks().map(tr => ({ tr, a: S.sel.start, b: S.sel.end }));
  else if (S.selClips.size) {
    const by = new Map();
    targetClips().forEach(({ tr, c }) => { const j = by.get(tr) || { tr, a: Infinity, b: -Infinity }; j.a = Math.min(j.a, c.start); j.b = Math.max(j.b, c.start + c.dur); by.set(tr, j); });
    jobs = [...by.values()];
  }
  jobs = jobs.filter(j => j.tr.clips.some(c => c.start < j.b && c.start + c.dur > j.a));
  if (!jobs.length) return status('Select a range or clips to consolidate');
  pushHistory();
  const ids = [];
  for (const { tr, a, b } of jobs) {
    if (tr.kind === 'inst') {
      const notes = [];
      for (const c of tr.clips) if (c.type === 'midi' && !c.muted) for (const n of c.notes) { const tl = c.start + n.t - c.offset; if (n.t >= c.offset && n.t < c.offset + c.dur && tl >= a && tl < b) notes.push({ ...n, t: tl - a }); }
      carveRange(tr, a, b);
      const mc = newMidiClip(notes, a, b - a, tr.name.replace(/\s+/g, '_') + '_Cons'); tr.clips.push(mc); sortClips(tr); ids.push(mc.id); continue;
    }
    const buf = renderTrackRange(tr, a, b);
    carveRange(tr, a, b);
    const c = newClip(addBuffer(buf, tr.name + '_Consolidated'), a, { name: tr.name.replace(/\s+/g, '_') + '_Cons' });
    tr.clips.push(c); sortClips(tr); ids.push(c.id);
  }
  S.selClips = new Set(ids);
  done('Consolidated into ' + ids.length + ' new clip' + (ids.length > 1 ? 's' : ''));
}

// ───────────────────────── Insert silence, repeat ─────────────────────────
function insertSilence() {
  if (!hasRange()) return status('Make a selection the length of silence to insert');
  pushHistory();
  const a = S.sel.start, len = S.sel.end - S.sel.start;
  for (const tr of selectedTracks()) {
    for (const c of [...tr.clips]) splitClip(tr, c, a);
    tr.clips.forEach(c => { if (c.start >= a - 1e-6) c.start += len; });
  }
  S.markers.forEach(m => { if (m.t >= a && selectedTracks().length === S.tracks.length) m.t += len; });
  done('Inserted ' + len.toFixed(2) + ' s of silence');
}
function repeatDialog() {
  const cb = gatherCopy(); if (!cb) return status('Select clips or a range to repeat');
  openModal('Repeat', `<div class="row" style="grid-template-columns:110px 1fr"><label>Number of repeats</label><input type="number" id="rpN" min="1" max="64" value="3"></div>`,
    [{ label: 'Cancel' }, { label: 'Repeat', primary: true, action: () => {
      const n = clamp(parseInt($('#rpN').value, 10) || 1, 1, 64);
      let at, idx;
      if (S.selClips.size) { const it = [...S.selClips].map(findClip); at = Math.max(...it.map(i => i.c.start + i.c.dur)); idx = Math.min(...it.map(i => S.tracks.indexOf(i.tr))); }
      else { at = S.sel.end; idx = S.tracks.indexOf(selectedTracks()[0]); }
      const before = history.undo.length;
      for (let i = 0; i < n; i++) pasteAt(cb, at + i * cb.len, idx);
      history.undo.length = before + 1; // one undo step for the whole repeat
      done('Repeated ' + n + ' time' + (n > 1 ? 's' : ''));
    } }]);
  setTimeout(() => $('#rpN').select(), 20);
}

// ───────────────────────── Strip Silence ─────────────────────────
function silenceRegions(c, thrDb, minLen, preP, postP) {
  const b = bufOf(c), sr = b.sampleRate, hop = Math.max(1, Math.round(sr * 0.005));
  const s0 = Math.floor(c.offset * sr), s1 = Math.min(b.length, Math.floor((c.offset + c.dur) * sr));
  const thr = dbToGain(thrDb), chs = [...Array(b.numberOfChannels).keys()].map(i => b.getChannelData(i));
  const loud = [];
  for (let i = s0; i < s1; i += hop) {
    let pk = 0; const e = Math.min(s1, i + hop);
    for (const d of chs) for (let j = i; j < e; j++) { const v = Math.abs(d[j]); if (v > pk) pk = v; }
    loud.push(pk >= thr);
  }
  const regs = []; let st = -1;
  loud.forEach((l, k) => { if (l && st < 0) st = k; if (!l && st >= 0) { regs.push([st, k]); st = -1; } });
  if (st >= 0) regs.push([st, loud.length]);
  // merge regions separated by less than the minimum silence length
  const out = [];
  for (const r of regs.map(([x, y]) => [x * hop / sr, y * hop / sr])) {
    if (out.length && r[0] - out[out.length - 1][1] < minLen) out[out.length - 1][1] = r[1]; else out.push(r);
  }
  return out.map(([x, y]) => [Math.max(0, x - preP), Math.min(c.dur, y + postP)]).filter(([x, y]) => y - x > 0.003);
}
function stripSilenceDialog() {
  const list = targetClips().filter(x => x.c.type !== 'midi'); if (!list.length) return status('Select audio clips (Grabber) or make a selection first');
  const m = openModal('Strip Silence', `<p>Removes the quiet parts of ${list.length} clip${list.length > 1 ? 's' : ''} and keeps the sound as separate clips, like Pro Tools Strip Silence.</p>
    <div class="row" style="grid-template-columns:160px 1fr"><label>Threshold (dB)</label><input type="range" id="ssThr" min="-72" max="-6" value="-40"><span id="ssThrV">-40</span></div>
    <div class="row" style="grid-template-columns:160px 1fr"><label>Minimum silence (ms)</label><input type="number" id="ssMin" value="120" min="5" max="5000"></div>
    <div class="row" style="grid-template-columns:160px 1fr"><label>Start pad (ms)</label><input type="number" id="ssPre" value="5" min="0" max="500"></div>
    <div class="row" style="grid-template-columns:160px 1fr"><label>End pad (ms)</label><input type="number" id="ssPost" value="40" min="0" max="2000"></div>
    <p id="ssInfo" style="color:var(--text-dim)"></p>`,
    [{ label: 'Cancel' }, { label: 'Strip', primary: true, action: () => apply() }]);
  const read = () => [+$('#ssThr').value, (+$('#ssMin').value || 120) / 1000, (+$('#ssPre').value || 0) / 1000, (+$('#ssPost').value || 0) / 1000];
  const preview = () => { $('#ssThrV').textContent = $('#ssThr').value; const n = list.reduce((s, { c }) => s + silenceRegions(c, ...read()).length, 0); $('#ssInfo').textContent = 'Result: ' + n + ' clip' + (n === 1 ? '' : 's') + ' will remain.'; };
  m.querySelectorAll('input').forEach(i => i.oninput = preview); preview();
  const apply = () => {
    pushHistory(); let total = 0;
    for (const { tr, c } of list) {
      const regs = silenceRegions(c, ...read());
      tr.clips = tr.clips.filter(x => x !== c);
      regs.forEach(([x, y], i) => { tr.clips.push({ ...c, id: uid('clp'), start: c.start + x, offset: c.offset + x, dur: y - x, fadeIn: Math.min(0.003, (y - x) / 4), fadeOut: Math.min(0.01, (y - x) / 4), name: c.name + '-' + String(i + 1).padStart(2, '0') }); });
      sortClips(tr); total += regs.length;
    }
    S.selClips.clear(); done('Strip Silence: ' + total + ' clips kept');
  };
}

// ───────────────────────── Time stretch (TCE, WSOLA) ─────────────────────────
function wsola(src, ratio) {
  const N = 2048, Hs = N / 2, Ha = Hs / ratio, tol = 512;
  const outLen = Math.max(N, Math.round(src.length * ratio));
  const out = new Float32Array(outLen + N), norm = new Float32Array(outLen + N);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  let prev = 0;
  for (let k = 0, op = 0; op < outLen; k++, op += Hs) {
    let ip = Math.round(k * Ha);
    if (k > 0) {
      const nat = prev + Hs; let best = 0, bestC = -Infinity;
      for (let d = -tol; d <= tol; d += 8) {
        const p = ip + d; if (p < 0 || p + Hs >= src.length) continue;
        let cc = 0; for (let j = 0; j < Hs; j += 4) cc += src[nat + j] * src[p + j] || 0;
        if (cc > bestC) { bestC = cc; best = d; }
      }
      ip = clamp(ip + best, 0, Math.max(0, src.length - 1));
    }
    for (let j = 0; j < N; j++) { const v = src[ip + j]; if (v === undefined) break; out[op + j] += v * win[j]; norm[op + j] += win[j]; }
    prev = ip;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out.subarray(0, outLen);
}
function timeStretchDialog() {
  const list = targetClips(); if (!list.length) return status('Select clips (Grabber) first');
  const fit = hasRange() && list.length === 1;
  openModal('Time Stretch (TCE)', `<p>Change clip length without changing pitch. ${fit ? 'Use "Fit to selection" to stretch the clip to the edit selection.' : ''}</p>
    <div class="row" style="grid-template-columns:140px 1fr"><label>New length (%)</label><input type="number" id="tsPct" value="100" min="25" max="400" step="1"></div>
    <div class="row" style="grid-template-columns:140px 1fr"><label>Or new tempo</label><input type="number" id="tsBpm" placeholder="from ${S.tempo} BPM to…" min="40" max="240"></div>`,
    [{ label: 'Cancel' }, ...(fit ? [{ label: 'Fit to selection', action: () => run((S.sel.end - S.sel.start) / list[0].c.dur) }] : []),
     { label: 'Stretch', primary: true, action: () => { const bpm = +$('#tsBpm').value; run(bpm ? S.tempo / bpm : (+$('#tsPct').value || 100) / 100); } }]);
  const run = ratio => {
    ratio = clamp(ratio, 0.25, 4); if (Math.abs(ratio - 1) < 1e-4) return;
    status('Stretching…');
    setTimeout(() => {
      pushHistory();
      for (const { tr, c } of list) {
        if (c.type === 'midi') { ownNotes(c); c.notes.forEach(n => { n.t = c.offset + (n.t - c.offset) * ratio; n.d = (n.d || 0.1) * (tr.inst?.type === 'drums' ? 1 : ratio); }); c.dur *= ratio; carveUnder(tr, c); continue; }
        const src = bufOf(c), sr = src.sampleRate, s0 = Math.floor(c.offset * sr), n = Math.floor(c.dur * sr);
        const chans = [...Array(src.numberOfChannels).keys()].map(i => wsola(src.getChannelData(i).subarray(s0, s0 + n), ratio));
        const out = ctx.createBuffer(chans.length, chans[0].length, sr);
        chans.forEach((d, i) => out.getChannelData(i).set(d));
        c.bufId = addBuffer(out, c.name + '_TCE'); c.offset = 0; c.dur = out.duration;
        c.fadeIn = Math.min(c.fadeIn * ratio, c.dur / 2); c.fadeOut = Math.min(c.fadeOut * ratio, c.dur / 2);
        carveUnder(tr, c); sortClips(tr);
      }
      done('Time stretched to ' + Math.round(ratio * 100) + '%');
    }, 20);
  };
}

// ───────────────────────── Tab to transient / clip boundary ─────────────────────────
const onsetCache = new Map();
function onsets(bufId) {
  if (onsetCache.has(bufId)) return onsetCache.get(bufId);
  const b = buffers.get(bufId).buffer, sr = b.sampleRate, hop = Math.round(sr * 0.005), d = b.getChannelData(0);
  const env = []; for (let i = 0; i < d.length; i += hop) { let s = 0; for (let j = i; j < Math.min(d.length, i + hop); j++) s += d[j] * d[j]; env.push(Math.sqrt(s / hop)); }
  const res = []; let last = -1;
  for (let k = 3; k < env.length; k++) {
    const base = (env[k - 1] + env[k - 2] + env[k - 3]) / 3;
    if (env[k] > 0.02 && env[k] > base * 2.2 + 0.004 && (k - last) * hop / sr > 0.06) {
      // refine to the first sample above half the local peak
      let i = (k - 1) * hop; const lim = Math.min(d.length, (k + 1) * hop), thr = env[k] * 0.5;
      while (i < lim && Math.abs(d[i]) < thr) i++;
      res.push(i / sr); last = k;
    }
  }
  onsetCache.set(bufId, res);
  return res;
}
function tabPoints(tr) {
  const pts = [];
  for (const c of tr.clips) {
    pts.push(c.start, c.start + c.dur);
    if (S.tabTransients && c.type === 'midi') { for (const n of c.notes) if (n.t >= c.offset && n.t < c.offset + c.dur) pts.push(c.start + n.t - c.offset); continue; }
    if (S.tabTransients) for (const o of onsets(c.bufId)) { const t = c.start + (o - c.offset); if (t > c.start + 0.002 && t < c.start + c.dur - 0.002) pts.push(t); }
  }
  return pts.sort((x, y) => x - y);
}
function tabTo(dir, extend) {
  const trs = selectedTracks().length ? selectedTracks() : S.tracks.slice(0, 1);
  if (!trs.length) return;
  const from = dir > 0 ? S.sel.end : S.sel.start;
  const pts = trs.flatMap(tabPoints).sort((x, y) => x - y);
  const t = dir > 0 ? pts.find(p => p > from + 0.0005) : [...pts].reverse().find(p => p < from - 0.0005);
  if (t === undefined) return status(dir > 0 ? 'No more ' + (S.tabTransients ? 'transients' : 'clip boundaries') + ' to the right' : 'Nothing to the left');
  if (extend) { if (dir > 0) S.sel.end = t; else S.sel.start = t; }
  else { S.sel.start = S.sel.end = t; }
  if (!T.playing) S.playhead = S.sel.start;
  S.sel.tracks = new Set(trs.map(x => x.id));
  const x = tToX(t); if (x < 0 || x > lanesW - 20) S.scrollT = Math.max(0, t - lanesW / 2 / S.pps);
  renderHeaders(); dirty();
}
function toggleTabTransients() { S.tabTransients = !S.tabTransients; status(S.tabTransients ? 'Tab to Transients on' : 'Tab to Transients off: Tab moves between clip boundaries'); updateTabBtn(); }

// ───────────────────────── Playlists & comping ─────────────────────────
function plInit(tr) { if (!tr.playlists) { tr.playlists = []; tr.plName = tr.name + '.01'; } }
function newPlaylist(dup) {
  const tr = selectedTracks()[0]; if (!tr) return status('Select a track first');
  plInit(tr); pushHistory();
  tr.playlists.push({ name: tr.plName, clips: tr.clips });
  tr.clips = dup ? tr.clips.map(c => ({ ...c, id: uid('clp') })) : [];
  tr.plName = tr.name + '.' + String(tr.playlists.length + 1).padStart(2, '0');
  if (T.playing) { stop(); play(); }
  done((dup ? 'Duplicated' : 'New') + ' playlist ' + tr.plName + ' on ' + tr.name);
}
function playlistsDialog() {
  const tr = selectedTracks()[0]; if (!tr) return status('Select a track first');
  plInit(tr);
  const rows = () => `<div class="song-row"><div><b>${escapeHtml(tr.plName)}</b><small>Active playlist · ${tr.clips.length} clips</small></div><span></span><span></span></div>` +
    tr.playlists.map((p, i) => `<div class="song-row"><div><b>${escapeHtml(p.name)}</b><small>${p.clips.length} clips</small></div><button data-comp="${i}" title="Copy the edit selection from this playlist onto the active playlist">Copy selection to active</button><button class="primary" data-sw="${i}">Make active</button></div>`).join('');
  const m = openModal('Playlists: ' + escapeHtml(tr.name), `<div class="wide"><p style="margin-bottom:8px">Keep alternate takes and edits as playlists. To comp, select the best section with the Selector, then copy it onto the active playlist.</p><div class="song-list" id="plList">${rows()}</div></div>`,
    [{ label: 'New playlist', action: () => { newPlaylist(false); } }, { label: 'Duplicate', action: () => { newPlaylist(true); } }, { label: 'Done', primary: true }]);
  const bind = () => {
    m.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => {
      const i = +b.dataset.sw; pushHistory();
      const p = tr.playlists[i]; tr.playlists[i] = { name: tr.plName, clips: tr.clips };
      tr.clips = p.clips; tr.plName = p.name;
      if (T.playing) { stop(); play(); }
      $('#plList').innerHTML = rows(); bind(); done('Active playlist: ' + tr.plName);
    });
    m.querySelectorAll('[data-comp]').forEach(b => b.onclick = () => {
      if (!hasRange()) return status('Make a selection first, then copy it from a playlist');
      const p = tr.playlists[+b.dataset.comp], a = S.sel.start, e = S.sel.end;
      pushHistory(); carveRange(tr, a, e);
      for (const c of p.clips) {
        const s = Math.max(a, c.start), en = Math.min(e, c.start + c.dur); if (en - s < 0.001) continue;
        tr.clips.push({ ...c, id: uid('clp'), start: s, offset: c.offset + (s - c.start), dur: en - s, fadeIn: s > c.start ? 0.005 : c.fadeIn, fadeOut: en < c.start + c.dur ? 0.005 : c.fadeOut });
      }
      sortClips(tr); $('#plList').innerHTML = rows(); bind(); done('Comped selection from ' + p.name);
    });
  };
  bind();
}

// ───────────────────────── Zoom to selection ─────────────────────────
let zoomBack = null;
function zoomToSelection() {
  if (zoomBack) { S.pps = zoomBack.pps; S.scrollT = zoomBack.scrollT; zoomBack = null; dirty(); return status('Zoom restored'); }
  let a, b;
  if (hasRange()) { a = S.sel.start; b = S.sel.end; }
  else if (S.selClips.size) { const it = targetClips(); a = Math.min(...it.map(i => i.c.start)); b = Math.max(...it.map(i => i.c.start + i.c.dur)); }
  else return status('Make a selection to zoom to');
  zoomBack = { pps: S.pps, scrollT: S.scrollT };
  S.pps = clamp((lanesW - 40) / (b - a), 1.5, 3000); S.scrollT = Math.max(0, a - 20 / S.pps); dirty();
  status('Zoomed to selection (press E again to go back)');
}

// ───────────────────────── Menus, toolbar, shortcuts ─────────────────────────
const _editMenu = MENUS.edit, _clipMenu0 = MENUS.clip, _trackMenu = MENUS.track, _viewMenu = MENUS.view, _optMenu = MENUS.options;
MENUS.edit = () => [..._editMenu(),
  { label: 'Heal Separation', k: K('Mod+H'), action: healSeparation },
  { label: 'Trim Clip to Selection', k: K('Mod+Alt+T'), action: trimToSelection },
  { label: 'Consolidate Clip', k: K('Alt+Shift+3'), action: consolidate },
  { sep: true },
  { label: 'Insert Silence', k: K('Mod+Shift+E'), action: insertSilence },
  { label: 'Repeat…', k: K('Alt+R'), action: repeatDialog },
  { label: 'Strip Silence…', k: K('Mod+U'), action: stripSilenceDialog },
  { label: 'Time Stretch (TCE)…', k: K('Mod+Alt+S'), action: timeStretchDialog },
  { sep: true },
  { label: 'Create Fades / Crossfade', k: K('Mod+F'), action: createFades },
];
MENUS.clip = () => [..._clipMenu0(), { sep: true },
  { label: 'Clip Gain…', action: clipGainDialog },
  { label: 'Clip Gain +1 dB', k: K('Mod+Shift') + '+↑', action: () => clipGainBy(1) },
  { label: 'Clip Gain −1 dB', k: K('Mod+Shift') + '+↓', action: () => clipGainBy(-1) },
  { label: 'Clip Mute / Unmute', k: K('Mod+M'), action: toggleClipMute },
  { label: 'Lock / Unlock Clip', k: K('Mod+L'), action: toggleClipLock },
];
MENUS.track = () => [..._trackMenu(), { sep: true },
  { label: 'New Playlist', k: K('Mod+\\'), action: () => newPlaylist(false) },
  { label: 'Duplicate Playlist', action: () => newPlaylist(true) },
  { label: 'Playlists and Comping…', action: playlistsDialog },
];
MENUS.view = () => [..._viewMenu(), { sep: true }, { label: 'Zoom to Selection (toggle)', k: 'E', action: zoomToSelection }];
MENUS.options = () => [..._optMenu(), { sep: true }, { label: 'Tab to Transients', checked: S.tabTransients, action: toggleTabTransients }];

// Tab to Transients button beside the edit tools
const tabBtn = document.createElement('button');
tabBtn.className = 'tool'; tabBtn.id = 'btnTabTr'; tabBtn.title = 'Tab to Transients (Tab moves to the next transient)';
tabBtn.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M2 10h3l2-6 3 12 2-8 1.5 2H18" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 6l3 4-3 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
tabBtn.dataset.tool = '';
const toolsGrp = document.querySelector('.tool')?.parentElement;
if (toolsGrp) toolsGrp.appendChild(tabBtn);
tabBtn.onclick = e => { e.stopPropagation(); toggleTabTransients(); };
function updateTabBtn() { tabBtn.classList.toggle('active', S.tabTransients); }

window.addEventListener('keydown', e => {
  if (!$('#modalBack').hidden) return;
  if (e.target.matches('input, select, textarea, [contenteditable="true"]')) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), code = e.code;
  const run = fn => { e.preventDefault(); e.stopImmediatePropagation(); fn(); };
  if (k === 'tab') return run(() => tabTo(e.altKey ? -1 : 1, e.shiftKey));
  if (mod && e.shiftKey && k === 'arrowup') return run(() => clipGainBy(1));
  if (mod && e.shiftKey && k === 'arrowdown') return run(() => clipGainBy(-1));
  if (mod && e.shiftKey && k === 'e') return run(insertSilence);
  if (mod && e.altKey && code === 'KeyT') return run(trimToSelection);
  if (mod && e.altKey && code === 'KeyS') return run(timeStretchDialog);
  if (mod && !e.shiftKey && k === 'h') return run(healSeparation);
  if (mod && !e.shiftKey && k === 'f') return run(createFades);
  if (mod && !e.shiftKey && k === 'm') return run(toggleClipMute);
  if (mod && !e.shiftKey && k === 'l') return run(toggleClipLock);
  if (mod && !e.shiftKey && k === 'u') return run(stripSilenceDialog);
  if (mod && k === '\\') return run(() => newPlaylist(false));
  if (!mod && e.altKey && e.shiftKey && code === 'Digit3') return run(consolidate);
  if (!mod && e.altKey && code === 'KeyR') return run(repeatDialog);
  if (mod || e.altKey) return;
  if (k === 'e') return run(zoomToSelection);
  if (code === 'NumpadAdd' || k === '.') return run(() => cmdNudge(1));
  if (code === 'NumpadSubtract' || k === ',') return run(() => cmdNudge(-1));
}, true);
