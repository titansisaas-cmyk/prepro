/* PrePro creative layer: welcome screen, Simple / Pro mode, one big Record button with count-in,
   plain-language labels, takes that are never lost, and first-time tips.
   Pro mode is the full studio, unchanged. */

// ───────────────────────── Preferences (device storage in the standalone build, session memory otherwise) ─────────────────────────
const SESSION_PREFS = new Map();
const PREF = {
  get(k, d) { try { const v = window.PREPRO_STORE?.getPref ? window.PREPRO_STORE.getPref(k) : SESSION_PREFS.get(k); return v ?? d; } catch (e) { return d; } },
  set(k, v) { SESSION_PREFS.set(k, v); try { window.PREPRO_STORE?.setPref?.(k, v); } catch (e) {} },
};

// ───────────────────────── Simple / Pro mode ─────────────────────────
S.simple = false;
const PLUG_PRO = Object.fromEntries(Object.entries(PLUGINS).map(([k, p]) => [k, p.name]));
const PLUG_FRIENDLY = { eq: 'Tone (EQ)', filter: 'Filter (darker or thinner)', comp: 'Punch (Compressor)', delay: 'Echo (Delay)', reverb: 'Space (Reverb)', trim: 'Volume Boost (Trim)' };
const MENU_FRIENDLY = {
  'New Session (empty)': 'Start a Blank Song',
  'Load Demo Session': 'Open the Demo Song',
  'Bounce Mix to WAV…': 'Export My Song as WAV…',
  'Save Song File (.prepro)…': 'Save a Copy to My Computer…',
  'Open Song File…': 'Open a Copy from My Computer…',
  'Rename Session…': 'Rename Song…',
  'Clear': 'Delete (leave a gap)',
  'Separate Clip at Selection': 'Cut Clip in Two (Separate)',
  'Heal Separation': 'Rejoin a Cut (Heal)',
  'Trim Clip to Selection': 'Keep Only the Selected Part (Trim)',
  'Consolidate Clip': 'Join Into One Clip (Consolidate)',
  'Insert Silence': 'Insert a Gap',
  'Repeat…': 'Repeat It…',
  'Strip Silence…': 'Remove the Quiet Parts (Strip Silence)…',
  'Time Stretch (TCE)…': 'Make Longer or Shorter (Time Stretch)…',
  'Create Fades / Crossfade': 'Smooth the Edges (Fades)',
  'Fade In / Out (10 ms)': 'Quick Fade (removes clicks)',
  'Fade In / Out (500 ms)': 'Gentle Fade In and Out',
  'Spot Selected Clip…': 'Move Clip to an Exact Time…',
  'Clip Gain…': 'Clip Volume…',
  'Clip Gain +1 dB': 'Clip Louder',
  'Clip Gain −1 dB': 'Clip Quieter',
  'Clip Mute / Unmute': 'Silence This Clip / Bring It Back',
  'Lock / Unlock Clip': 'Lock Clip So It Cannot Move',
  'Normalize': 'Make as Loud as Possible (Normalize)',
  'Reverse': 'Play Backwards (Reverse)',
  'New…': 'New Track…',
  'New Drum Track (MIDI)': 'New Drum Track (for electronic drums)',
  'New Instrument Track (Synth)': 'New Keyboard Track',
  'New MIDI Out Track (external plug-in)': 'New Track for an Outside Plug-in',
  'Instrument Settings…': 'Drum Kit or Sound Settings…',
  'New Empty MIDI Clip': 'New Empty Note Clip',
  'New Playlist': 'New Empty Take',
  'Duplicate Playlist': 'Copy This Take',
  'Playlists and Comping…': 'My Takes…',
  'Tempo…': 'Song Speed (Tempo)…',
  'Add Marker at Playhead': 'Add a Section Marker Here',
  'Memory Locations…': 'Section Markers…',
  'Quantize MIDI…': 'Tidy Up Timing (Quantize)…',
  'MIDI Editor': 'Note Editor',
  'MIDI Setup…': 'Connect Drums or Keyboard (MIDI)…',
  'Import Audio…': 'Add a Sound File…',
  'Import MIDI…': 'Add a MIDI File…',
  'Export MIDI…': 'Save Notes as a MIDI File…',
  'Track Height: Small': 'Smaller Tracks',
  'Track Height: Medium': 'Medium Tracks',
  'Track Height: Large': 'Bigger Tracks',
};
const _showDropdown = showDropdown;
showDropdown = function (items, x, y) {
  if (S.simple) items = items.map(it => it.label && MENU_FRIENDLY[it.label] ? { ...it, label: MENU_FRIENDLY[it.label] } : it);
  return _showDropdown(items, x, y);
};
function setSimple(on, quiet) {
  S.simple = !!on;
  if (!S.simple) { tipEl?.remove(); tipEl = null; }
  document.body.classList.toggle('simple', S.simple);
  for (const k in PLUGINS) PLUGINS[k].name = S.simple ? (PLUG_FRIENDLY[k] || PLUG_PRO[k]) : PLUG_PRO[k];
  if (S.simple) { S.mode = 'slip'; S.tool = 'smart'; S.showClipList = false; }
  else S.showClipList = true;
  $('#editWin').classList.toggle('no-clips', !S.showClipList);
  $('#tpLoop').textContent = S.simple ? 'Loop' : 'LOOP';
  $('#tpClick').textContent = S.simple ? 'Metronome' : 'CLICK';
  const ml = $('.ml.inserts'); if (ml) ml.textContent = S.simple ? 'Effects' : 'Inserts A–E';
  $('#modeSimple').classList.toggle('active', S.simple); $('#modePro').classList.toggle('active', !S.simple);
  PREF.set('simple', S.simple);
  updateTransportUI(); refreshAll(); setTimeout(sizeCanvases, 0);
  if (!quiet) status(S.simple ? 'Simple mode: the essentials, in plain words. Switch to Pro any time for the full studio.' : 'Pro mode: the full studio');
}

// ───────────────────────── Toolbar: mode switch and creative controls ─────────────────────────
const ICON = {
  rec: '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="6.5" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="4.5" y="4.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M8 5L3.5 9.5 8 14M4 9.5h7.5a5 5 0 010 10H9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  redo: '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M12 5l4.5 4.5L12 14M16 9.5H8.5a5 5 0 000 10H11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  takes: '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M3 5h14M3 10h14M3 15h9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  share: '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M10 13V3M6 7l4-4 4 4M4 12v4h12v-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 20 20" width="18" height="18"><path d="M6 4l10 6-10 6z" fill="currentColor"/></svg>',
  help: '<svg viewBox="0 0 20 20" width="15" height="15"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7.8 7.6a2.3 2.3 0 114 1.6c-.9.7-1.8 1.1-1.8 2.4M10 14.3v.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
(() => {
  const tb = $('header.toolbar');
  const grp = document.createElement('div');
  grp.className = 'tb-group simple-only creative-bar';
  grp.innerHTML = `
    <button id="bigRec" class="big-rec" title="Record. PrePro counts you in, then records. Press again to stop.">${ICON.rec}<span>Record</span></button>
    <button id="bigPlay" class="big-play" title="Play my song from the start. Press again to stop.">${ICON.play}<span>Play</span></button>
    <button id="countInBtn" class="pill on" title="Count me in: four clicks before recording starts">Count-in</button>
    <button id="bigUndo" class="pill icon" title="Undo. You can always go back.">${ICON.undo}<span>Undo</span></button>
    <button id="bigRedo" class="pill icon" title="Redo">${ICON.redo}</button>
    <button id="bigTakes" class="pill icon" title="My takes: every earlier version of a track is kept here">${ICON.takes}<span>Takes</span></button>
    <button id="bigShare" class="pill icon" title="Export my song as a WAV file to share">${ICON.share}<span>Export</span></button>
    <button id="bigHelp" class="pill icon" title="How PrePro works">${ICON.help}</button>`;
  tb.insertBefore(grp, tb.querySelector('.tools').nextSibling);
  const ms = document.createElement('div');
  ms.className = 'tb-group mode-switch'; ms.setAttribute('role', 'group'); ms.setAttribute('aria-label', 'Interface mode');
  ms.innerHTML = '<button id="modeSimple" title="Simple mode: the essentials, in plain words">Simple</button><button id="modePro" title="Pro mode: the full studio">Pro</button>';
  tb.appendChild(ms);
  $('#modeSimple').onclick = () => setSimple(true);
  $('#modePro').onclick = () => setSimple(false);
  $('#bigRec').onclick = bigRecord;
  $('#bigPlay').onclick = bigPlay;
  $('#countInBtn').onclick = () => { const v = !PREF.get('countIn', true); PREF.set('countIn', v); syncCreativeBar(); status(v ? 'Count-in on: four clicks before recording' : 'Count-in off: recording starts right away'); };
  $('#bigUndo').onclick = () => undo();
  $('#bigRedo').onclick = () => redo();
  $('#bigTakes').onclick = () => { if (!selectedTracks()[0] && S.tracks[0]) S.sel.tracks = new Set([S.tracks[0].id]); playlistsDialog(); };
  $('#bigShare').onclick = () => { if (!sessionEnd()) return status('Record something first, then export it'); S.sel.end = S.sel.start; bounce(); };
  $('#bigHelp').onclick = helpDialog;
})();
// one big Play button: plays from the start of the song if the play position is at (or past) the end
function bigPlay() {
  if (T.recording || counting) return;
  if (T.playing) { stop(); syncCreativeBar(); return; }
  const end = sessionEnd();
  if (!end) return status('Record something first, then press Play');
  if (S.sel.start >= end - 0.05) setInsertion(0);
  play(); syncCreativeBar();
}
{ const _play = play, _stop = stop;
  play = async function (...a) { const r = await _play(...a); syncCreativeBar(); return r; };
  stop = function (...a) { const r = _stop(...a); syncCreativeBar(); return r; }; }
function syncCreativeBar() {
  const b = $('#bigRec'); if (!b) return;
  const rec = T.recording || counting;
  b.classList.toggle('on', rec);
  b.innerHTML = (rec ? ICON.stop : ICON.rec) + `<span>${counting ? 'Get ready' : rec ? 'Stop' : 'Record'}</span>`;
  const pb = $('#bigPlay');
  if (pb) { pb.classList.toggle('on', T.playing); pb.innerHTML = (T.playing ? ICON.stop : ICON.play) + `<span>${T.playing ? 'Stop' : 'Play'}</span>`; pb.disabled = rec; }
  $('#countInBtn').classList.toggle('on', PREF.get('countIn', true));
  $('#bigUndo').disabled = !history.undo.length; $('#bigRedo').disabled = !history.redo.length;
  $('#bigUndo').querySelector('span').textContent = history.undo.length ? 'Undo' : 'Undo';
}
const _updateTransportUI = updateTransportUI;
updateTransportUI = function () { _updateTransportUI(); syncCreativeBar(); };
setInterval(syncCreativeBar, 500);

// ───────────────────────── One big Record button ─────────────────────────
let counting = false;
let countAbort = null;
function nextIdeaName() { let n = 1; while (S.tracks.some(t => t.name === 'Idea ' + n)) n++; return 'Idea ' + n; }
function keepTakes(tracks, from) {
  for (const tr of tracks) {
    if (!tr.clips.some(c => c.start + c.dur > from + 0.01)) continue;
    plInit(tr);
    tr.playlists.push({ name: tr.plName, clips: tr.clips.map(c => ({ ...c, id: uid('clp') })) });
    tr.plName = tr.name + '.' + String(tr.playlists.length + 1).padStart(2, '0');
    S.tookOver = tr.name;
  }
}
function countIn() {
  return new Promise(res => {
    counting = true; syncCreativeBar();
    const spb = beatSec(), t0 = ctx.currentTime + 0.06;
    const ov = document.createElement('div'); ov.className = 'count-in'; ov.innerHTML = '<b></b><span>Get ready</span>'; document.body.appendChild(ov);
    const timers = [];
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = i === 0 ? 1600 : 1100; o.type = 'square';
      g.gain.setValueAtTime(0, t0 + i * spb); g.gain.linearRampToValueAtTime(0.18, t0 + i * spb + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * spb + 0.06);
      o.connect(g).connect(ctx.destination); o.start(t0 + i * spb); o.stop(t0 + i * spb + 0.08);
      timers.push(setTimeout(() => { ov.querySelector('b').textContent = 4 - i; ov.classList.remove('beat'); void ov.offsetWidth; ov.classList.add('beat'); }, i * spb * 1000 + 60));
    }
    const finish = ok => { timers.forEach(clearTimeout); ov.remove(); counting = false; countAbort = null; syncCreativeBar(); res(ok); };
    countAbort = () => finish(false);
    timers.push(setTimeout(() => finish(true), 4 * spb * 1000 - 20));
  });
}
async function bigRecord() {
  if (counting) { countAbort?.(); status('Recording cancelled'); return; }
  if (T.playing) { stop(); return; }
  if (ctx.state !== 'running') await ctx.resume();
  let targets = S.tracks.filter(t => t.arm);
  if (!targets.length) { const sel = selectedTracks()[0]; if (sel) targets = [sel]; }
  if (!targets.length) { pushHistory(); targets = [newTrack(nextIdeaName())]; }
  targets.forEach(t => { t.arm = true; });
  S.sel.tracks = new Set(targets.map(t => t.id));
  refreshAll();
  if (targets.some(t => t.kind !== 'inst')) {
    status('Allow the microphone when your browser asks');
    const ok = await ensureMic(); if (!ok) return;
  }
  if (targets.some(isInst)) midiEnsure(true);
  S.tookOver = null;
  keepTakes(targets, S.sel.start);
  if (PREF.get('countIn', true)) { const ok = await countIn(); if (!ok) return; }
  recordNow();
  status('Recording on ' + targets.map(t => t.name).join(', ') + '. Press the big button again to stop.');
  if (S.tookOver) setTimeout(() => tip('takes', `Your earlier version of <b>${escapeHtml(S.tookOver)}</b> is safe. Open <b>Takes</b> to hear it or bring it back.`, '#bigTakes'), 600);
}
// space bar or the transport Record button while counting cancels the count-in
window.addEventListener('keydown', e => { if (counting && (e.code === 'Space' || e.code === 'Escape')) { e.preventDefault(); e.stopImmediatePropagation(); countAbort?.(); status('Recording cancelled'); } }, true);

// after a take: tip and automatic saving
const _finishRecording = finishRecording;
finishRecording = function (endPos) {
  const r = _finishRecording(endPos);
  if (S.simple) {
    ensureAutoSave();
    setTimeout(() => tip('afterTake', 'Nice take. Press the green <b>Play</b> button to hear it. Drag the middle of a clip to move it, or drag its edges to shorten it. Made a mistake? <b>Undo</b> always takes you back.', '#bigUndo'), 1200);
  }
  return r;
};
function ensureAutoSave() {
  if (S.songId) return;
  if (!S.name || S.name === 'Untitled Session' || S.name === 'Demo Session') { S.name = 'My Song ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); $('#sessionName').textContent = S.name; }
  S.songId = uid('song') + '-' + Date.now();
  setTimeout(() => saveSong(false, true), 2500);
}

// ───────────────────────── Tips that appear once, at the moment they matter ─────────────────────────
const TIPS_SEEN = new Set(PREF.get('tips', []));
let tipEl = null;
function tip(id, html, anchorSel) {
  if (!S.simple || TIPS_SEEN.has(id)) return;
  if (!$('#modalBack').hidden) return;
  const a = $(anchorSel); if (!a || !a.offsetParent) return;
  TIPS_SEEN.add(id); PREF.set('tips', [...TIPS_SEEN]);
  tipEl?.remove();
  const d = tipEl = document.createElement('div'); d.className = 'coach'; d.dataset.tip = id;
  d.innerHTML = `<p>${html}</p><button>Got it</button>`;
  document.body.appendChild(d);
  const r = a.getBoundingClientRect(), w = d.offsetWidth;
  const left = Math.max(10, Math.min(innerWidth - w - 10, r.left + r.width / 2 - w / 2));
  const below = r.bottom + d.offsetHeight + 16 < innerHeight;
  d.style.left = left + 'px'; d.style.top = (below ? r.bottom + 12 : r.top - d.offsetHeight - 12) + 'px';
  d.classList.add(below ? 'below' : 'above');
  d.style.setProperty('--ax', (r.left + r.width / 2 - left) + 'px');
  d.querySelector('button').onclick = () => { d.remove(); tipEl = null; };
  setTimeout(() => { if (tipEl === d) { d.remove(); tipEl = null; } }, 16000);
}
const _setView = setView;
setView = function (v) { _setView(v); if (v === 'mix') setTimeout(() => tip('mix', 'Slide the faders to balance your tracks. Click an empty <b>Effects</b> slot to add Echo, Space or Punch.', '#btnMix'), 300); };

// ───────────────────────── Help ─────────────────────────
function helpDialog() {
  openModal('Making a song in PrePro', `<div class="help-steps">
    <ol>
      <li><b>Record.</b> Press the big red <b>Record</b> button. PrePro counts you in with four clicks, then records. Press it again to stop.</li>
      <li><b>Listen.</b> Press <b>Space</b> to play and stop. Click anywhere on the timeline to move the play position.</li>
      <li><b>Shape it.</b> Drag a clip to move it. Drag its edges to shorten it. Drag the top corners to fade it in or out.</li>
      <li><b>Add more.</b> Record again on a new track, or ask <b>AI</b> for a bass line or a beat in plain words.</li>
      <li><b>Balance.</b> Open <b>Mix</b> to set volumes and add effects such as Echo and Space.</li>
      <li><b>Share.</b> Press <b>Export</b> to make a WAV file of your song.</li>
    </ol>
    <p class="hint">Nothing is lost: <b>Undo</b> always takes you back, earlier takes are kept in <b>Takes</b>, and your song saves itself as you work. When you want every professional tool, switch to <b>Pro</b> at the top right.</p>
  </div>`, [
    { label: 'Show tips again', action: () => { TIPS_SEEN.clear(); PREF.set('tips', []); status('Tips will appear again as you work'); } },
    { label: 'Welcome screen', action: () => setTimeout(showWelcome, 0) },
    { label: 'Close', primary: true },
  ]);
}

// ───────────────────────── Grooves for "Start from a beat" ─────────────────────────
const GROOVES = {
  rock: { name: 'Rock', bpm: 110, desc: 'Steady and driving', k: [0, 8, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14] },
  pop: { name: 'Pop / Dance', bpm: 120, desc: 'Four on the floor', k: [0, 4, 8, 12], s: [4, 12], clap: true, oh: [2, 6, 10, 14] },
  hiphop: { name: 'Hip hop', bpm: 90, desc: 'Laid back, heavy kick', k: [0, 7, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], swing: 0.12 },
  funk: { name: 'Funk', bpm: 100, desc: 'Busy and syncopated', k: [0, 3, 10], s: [4, 12], ghost: [7, 9, 15], h: [...Array(16).keys()] },
  ballad: { name: 'Ballad', bpm: 72, desc: 'Slow and gentle', k: [0, 8], s: [4, 12], rimS: true, h: [0, 2, 4, 6, 8, 10, 12, 14] },
  latin: { name: 'Reggaeton', bpm: 94, desc: 'Dembow bounce', k: [0, 4, 8, 12], s: [3, 6, 11, 14], h: [0, 2, 4, 6, 8, 10, 12, 14] },
};
function grooveNotes(g, bars) {
  const st = beatSec() / 4, notes = [];
  const add = (step, bar, n, v) => { let t = (bar * 16 + step) * st; if (g.swing && step % 2) t += g.swing * st * 2; notes.push({ t, d: 0.1, n, v }); };
  for (let bar = 0; bar < bars; bar++) {
    const fill = bar % 4 === 3;
    g.k.forEach(s => add(s, bar, 36, s === 0 ? 112 : 100));
    g.s.forEach(s => { if (!(fill && s === 12)) add(s, bar, g.clap ? 39 : g.rimS ? 37 : 38, 104); });
    (g.ghost || []).forEach(s => add(s, bar, 38, 38));
    (g.h || []).forEach(s => { if (!(fill && s >= 12)) add(s, bar, 42, s % 4 === 0 ? 92 : 66); });
    (g.oh || []).forEach(s => { if (!(fill && s >= 12)) add(s, bar, 46, 80); });
    if (fill) [[12, 48], [13, 48], [14, 45], [15, 43]].forEach(([s, n]) => add(s, bar, n, 100));
    if (bar % 4 === 0) add(0, bar, 49, bar ? 110 : 96);
  }
  return notes;
}

// ───────────────────────── Welcome screen ─────────────────────────
function freshSession(name) {
  tipEl?.remove(); tipEl = null;
  stop();
  for (const t of S.tracks) destroyLiveChain(t.id);
  S.tracks = []; S.markers = []; buffers.clear(); trackCounter = 0;
  S.sel = { start: 0, end: 0, tracks: new Set() }; S.selClips.clear(); S.playhead = 0; S.scrollT = 0; S.loop = false;
  history.undo = []; history.redo = [];
  S.name = name; $('#sessionName').textContent = name; S.songId = null;
}
function startRecordIdea() {
  freshSession('My Idea');
  const t = newTrack('Idea 1'); t.arm = true; S.sel.tracks = new Set([t.id]);
  S.songId = uid('song') + '-' + Date.now();
  setSimple(true, true); refreshAll(); zoomFit();
  ensureMic().then(ok => status(ok ? 'Microphone ready. Press the big red Record button when you are ready.' : ''));
  setTimeout(() => tip('rec', 'Press the big red <b>Record</b> button. PrePro clicks four times to count you in, then records. Press it again to stop.', '#bigRec'), 400);
}
function startDrums() {
  freshSession('My Drums');
  const t = makeInstTrack('drums', 'My Drums'); t.arm = true; S.sel.tracks = new Set([t.id]);
  S.songId = uid('song') + '-' + Date.now();
  setSimple(true, true); refreshAll(); zoomFit();
  midiEnsure(true).then(ok => {
    const names = MIDI.access ? [...MIDI.access.inputs.values()].map(i => i.name) : [];
    status(ok ? (names.length ? 'Connected to ' + names.join(', ') + '. Hit a pad to hear your kit.' : 'Plug in your drums with USB. PrePro will find them automatically.') : (MIDI.err || 'Your browser did not allow MIDI. Open PrePro in Chrome or Edge in its own tab.'));
  });
  setTimeout(() => tip('rec', 'Hit a pad to hear your kit. When you are ready, press the big red <b>Record</b> button and play.', '#bigRec'), 400);
}
function beatDialog() {
  let pick = 'rock';
  const m = openModal('Start from a beat', `<div class="beat-dlg">
    <p class="hint">Pick a feel. PrePro writes an 8-bar drum beat you can play over, change, or replace.</p>
    <div class="groove-grid">${Object.entries(GROOVES).map(([k, g]) => `<button data-g="${k}" class="${k === pick ? 'on' : ''}"><b>${g.name}</b><span>${g.desc}</span></button>`).join('')}</div>
    <label class="tempo-row">Speed <input type="range" id="bdTempo" min="60" max="180" value="${GROOVES[pick].bpm}"><output id="bdTempoV">${GROOVES[pick].bpm} BPM</output></label>
    <label class="chk-row"><input type="checkbox" id="bdIdea" checked> Add a track ready to record my voice or instrument</label>
  </div>`, [{ label: 'Back', action: () => setTimeout(showWelcome, 0) }, { label: 'Make my beat', primary: true, action: () => makeBeat(pick, +$('#bdTempo').value, $('#bdIdea').checked) }]);
  m.querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
    pick = b.dataset.g; m.querySelectorAll('[data-g]').forEach(x => x.classList.toggle('on', x === b));
    $('#bdTempo').value = GROOVES[pick].bpm; $('#bdTempoV').textContent = GROOVES[pick].bpm + ' BPM';
  });
  $('#bdTempo').oninput = e => $('#bdTempoV').textContent = e.target.value + ' BPM';
}
function makeBeat(key, bpm, idea) {
  const g = GROOVES[key];
  freshSession(g.name + ' Idea');
  setTempo(bpm);
  const d = makeInstTrack('drums', 'Beat');
  const bars = 8, dur = bars * 4 * beatSec();
  d.clips.push(newMidiClip(grooveNotes(g, bars), 0, dur, g.name.replace(/\W+/g, '_') + '_Beat'));
  S.markers = [{ id: uid('mk'), t: 0, name: 'Verse' }, { id: uid('mk'), t: dur / 2, name: 'Chorus' }];
  let target = d;
  if (idea) { target = newTrack('Idea 1'); target.arm = true; }
  S.sel.tracks = new Set([target.id]);
  S.songId = uid('song') + '-' + Date.now();
  setSimple(true, true); refreshAll(); zoomFit();
  status('Your ' + g.name.toLowerCase() + ' beat is ready. Press Space to hear it, or the big red Record button to play along.');
  setTimeout(() => tip('rec', 'Press <b>Space</b> to hear your beat. When you are ready, press the big red <b>Record</b> button and play or sing along.', '#bigRec'), 400);
}
function showWelcome() {
  $('#welcome')?.remove(); tipEl?.remove(); tipEl = null;
  const w = document.createElement('div'); w.id = 'welcome'; w.className = 'welcome';
  const persistent = !!window.PREPRO_STORE;
  w.innerHTML = `<div class="wc-card" role="dialog" aria-modal="true" aria-labelledby="wcTitle">
    <div class="wc-brand"><span class="dot"></span>PrePro</div>
    <h1 id="wcTitle">What would you like to make today?</h1>
    <p class="wc-sub">From the first idea to the finished song. Catch it in the rehearsal room or on the go, then take it all the way here.</p>
    <div class="wc-tiles">
      <button data-go="idea"><span class="wc-ic">
        <svg viewBox="0 0 48 48"><rect x="17" y="6" width="14" height="24" rx="7" fill="currentColor"/><path d="M11 23a13 13 0 0026 0M24 36v6M17 42h14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></span>
        <b>Record an idea</b><span>Sing, play guitar or hum a melody. PrePro sets up your microphone and counts you in.</span></button>
      <button data-go="drums"><span class="wc-ic">
        <svg viewBox="0 0 48 48"><ellipse cx="24" cy="30" rx="15" ry="6" fill="none" stroke="currentColor" stroke-width="3"/><path d="M9 30v6c0 3.3 6.7 6 15 6s15-2.7 15-6v-6" fill="none" stroke="currentColor" stroke-width="3"/><path d="M14 8l9 17M36 6l-9 19" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></span>
        <b>Play my drums</b><span>Plug in electronic drums such as the Roland TD-17 and play right away.</span></button>
      <button data-go="beat"><span class="wc-ic">
        <svg viewBox="0 0 48 48"><path d="M8 34V20M16 34V12M24 34V24M32 34V8M40 34V18" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M6 41h36" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></span>
        <b>Start from a beat</b><span>Choose a feel and a speed. PrePro writes a drum beat for you to build on.</span></button>
    </div>
    <div class="wc-links">
      <button data-go="open">Open a saved song</button>
      <button data-go="demo">Explore the demo song</button>
      <button data-go="pro" class="wc-pro">Full studio for engineers (Pro mode)</button>
    </div>
    ${persistent ? '<label class="wc-again"><input type="checkbox" id="wcAgain" checked> Show this when PrePro opens</label>' : ''}
  </div>`;
  document.body.appendChild(w);
  const close = () => { w.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); setSimple(PREF.get('simple', true), true); } };
  document.addEventListener('keydown', esc, true);
  w.querySelector('#wcAgain')?.addEventListener('change', e => PREF.set('welcome', e.target.checked));
  w.addEventListener('click', e => {
    const b = e.target.closest('[data-go]'); if (!b) return;
    if (ctx.state !== 'running') ctx.resume();
    close();
    ({
      idea: startRecordIdea,
      drums: startDrums,
      beat: beatDialog,
      open: () => { setSimple(PREF.get('simple', true), true); openSongDialog(); },
      demo: () => { setSimple(true, true); status('This is the demo song. Press Space to play it.'); setTimeout(() => tip('demo', 'Press <b>Space</b> to play. Press the big red <b>Record</b> button to add your own part on a new track.', '#bigRec'), 300); },
      pro: () => setSimple(false),
    })[b.dataset.go]();
  });
  setTimeout(() => w.querySelector('[data-go="idea"]').focus(), 50);
}

// Help menu entries
const _helpMenu = MENUS.help;
MENUS.help = () => [{ label: 'How PrePro Works', action: helpDialog }, { label: 'Welcome Screen', action: showWelcome }, { sep: true }, ..._helpMenu()];
const _viewMenu2 = MENUS.view;
MENUS.view = () => [{ label: 'Simple Mode', checked: S.simple, action: () => setSimple(true) }, { label: 'Pro Mode (full studio)', checked: !S.simple, action: () => setSimple(false) }, { sep: true }, ..._viewMenu2()];

// Boot
setSimple(PREF.get('simple', true), true);
if (location.hash === '#record') { try { window.history.replaceState(null, '', location.pathname + location.search); } catch (e) {} startRecordIdea(); }
else if (PREF.get('welcome', true)) showWelcome();

// ───────────────────────── Microphone help and phone-friendly messages ─────────────────────────
let micError = null;
ensureMic = async function () {
  if (micStream) return true;
  micError = null;
  if (!navigator.mediaDevices?.getUserMedia) { micError = 'unsupported'; showMicHelp(); return false; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(S.audioIn ? { deviceId: { exact: S.audioIn } } : {}) } });
    micSource = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 1024;
    micSource.connect(micAnalyser);
    return true;
  } catch (e) {
    micError = e && e.name === 'NotFoundError' ? 'none' : 'blocked';
    _status('Microphone unavailable: allow audio input in your browser to record');
    showMicHelp();
    return false;
  }
};
function showMicHelp() {
  tipEl?.remove(); tipEl = null;
  const framed = window.top !== window;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);
  const ua = navigator.userAgent;
  // a built-in app browser (Perplexity, Facebook, Instagram...) on iPhone cannot use the microphone at all
  const inApp = ios && (!/Safari\//.test(ua) || /Perplexity|FBAN|FBAV|Instagram|GSA\/|Line\//i.test(ua));
  if (micError === 'none' && !inApp) return openModal('No microphone found', '<p class="mic-one">Plug in a microphone, then tap Try again.</p>', [{ label: 'Not now' }, { label: 'Try again', primary: true, action: () => setTimeout(bigRecord, 0) }]);
  // inside another page: one tap opens PrePro on its own, straight into recording
  if (framed && !inApp) return openModal('One quick step', '<p class="mic-one">Your device only lets PrePro use the microphone when PrePro is open on its own. Tap below, then tap <b>Allow</b> when asked.</p>',
    [{ label: 'Not now' }, { label: 'Open PrePro', primary: true, action: () => window.open(location.href.split('#')[0] + '#record', '_blank') }]);
  if (ios && (inApp || micError === 'blocked')) {
    const link = location.href.split('#')[0] + '#record';
    const copy = () => {
      const f = $('#micLink'); let ok = false;
      try { f.focus(); f.select(); f.setSelectionRange(0, link.length); ok = document.execCommand('copy'); } catch (e) {}
      try { navigator.clipboard?.writeText(link).catch(() => {}); ok = ok || !!navigator.clipboard; } catch (e) {}
      const btn = $('#modal [data-b="1"]'); if (btn) btn.textContent = ok ? 'Copied' : 'Hold the link above to copy';
      return false; // keep the dialog open
    };
    const openSafari = () => { location.href = 'x-safari-' + link; return false; };
    const lead = inApp ? 'This screen is inside another app, and it cannot use the microphone.'
      : 'If you are inside the Perplexity app or another app, the microphone will not work there.';
    const m = openModal('Open PrePro in Safari', `<p class="mic-one">${lead} Tap <b>Open in Safari</b>, then tap <b>Allow</b>.</p>
      <p class="mic-small">If Safari does not open, tap <b>Copy link</b>, open <b>Safari</b> yourself, and paste it into the address bar.</p>
      <input id="micLink" class="mic-link" readonly value="${link}">` +
      (inApp ? '' : '<p class="mic-small">Already in Safari? Tap <b>aA</b>, then <b>Website Settings</b>, and set <b>Microphone</b> to <b>Allow</b>.</p>'),
      [{ label: 'Not now' }, { label: 'Copy link', action: copy }, { label: 'Open in Safari', primary: true, action: openSafari }]);
    m.querySelector('#micLink').onclick = e => e.target.select();
    return m;
  }
  const how = android ? 'Tap the icon next to the web address, then <b>Permissions</b>, and allow the <b>Microphone</b>. If you are inside another app, open this page in Chrome instead.'
    : 'Click the icon next to the web address and allow the <b>Microphone</b>.';
  openModal('Allow the microphone', `<p class="mic-one">${how}</p>`, [{ label: 'Not now' }, { label: 'Try again', primary: true, action: () => setTimeout(bigRecord, 0) }]);
}
// in Simple mode, the transport Record button records in one press, like the big button
(() => {
  const b = $('#tpRec'), orig = b.onclick;
  b.onclick = e => (S.simple ? bigRecord() : orig(e));
})();
// phones hide the status line, so show important messages as a short notice
let noticeEl = null, noticeTimer = 0;
const _status = status;
status = function (msg) {
  _status(msg);
  if (!S.simple || innerWidth > 900 || !msg || /^(Playing|Stopped|Recording…|Undo|Redo)$/.test(msg)) return;
  if (!noticeEl) { noticeEl = document.createElement('div'); noticeEl.className = 'notice'; document.body.appendChild(noticeEl); }
  noticeEl.textContent = msg; noticeEl.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, 4500);
};
