/* PrePro Stage: the easy home for an idea.
   Research behind it: many people picture a mix as a stage (Dewey, Wakefield and Moore, 2026),
   scrolling hurts listening (Mycroft, 2017), and musicians need to see what the software is doing.
   Drag a part left or right to place it, toward the front to make it louder, toward the back to make it quieter.
   The Song Journey strip shows the next step from idea to finished song. */
'use strict';

const STAGE_ICON = {
  stage: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M2 16h16M4 16l2-8h8l2 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/><circle cx="10" cy="5" r="2.2" fill="currentColor"/></svg>',
  whole: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M3 6V3h3M14 3h3v3M17 14v3h-3M6 17H3v-3M6 8h8M6 12h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" width="12" height="12"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ───────────────────────── Geometry: volume and pan to a spot on the stage ─────────────────────────
const STG = { sel: null, w: 0, h: 0, raf: 0, mixed: false, shared: false };
const ST_DB0 = -24, ST_DB1 = 6; // back edge -24 dB, front edge +6 dB, evenly spaced in dB
function stageGeom() {
  const a = $('#stageArea'); const w = a.clientWidth, h = a.clientHeight;
  return { w, h, cx: w / 2, y0: h * 0.14, y1: h * 0.88, bw: w * 0.3, fw: w * 0.46 };
}
function trToStage(tr, g) {
  const db = tr.vol === -Infinity ? ST_DB0 : tr.vol;
  const f = clamp((db - ST_DB0) / (ST_DB1 - ST_DB0), 0, 1);
  const hw = g.bw + (g.fw - g.bw) * f;
  return { x: g.cx + clamp(tr.pan, -1, 1) * hw, y: g.y0 + f * (g.y1 - g.y0), f };
}
function stageToMix(x, y, g) {
  const f = clamp((y - g.y0) / (g.y1 - g.y0), 0, 1);
  const hw = g.bw + (g.fw - g.bw) * f;
  let pan = clamp((x - g.cx) / hw, -1, 1); if (Math.abs(pan) < 0.05) pan = 0;
  const db = Math.round((ST_DB0 + f * (ST_DB1 - ST_DB0)) * 2) / 2;
  return { pan: Math.round(pan * 100) / 100, db };
}
const panWords = p => Math.abs(p) < 0.01 ? 'centre' : (p < 0 ? 'left ' : 'right ') + Math.round(Math.abs(p) * 100);
const volWords = db => db === -Infinity ? 'silent' : (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';

// ───────────────────────── The Stage window ─────────────────────────
(() => {
  const w = document.createElement('main');
  w.className = 'stage-window'; w.id = 'stageWin'; w.hidden = true;
  w.innerHTML = `
    <div class="journey" id="journey" role="list" aria-label="Song journey"></div>
    <div class="stage-area" id="stageArea" aria-label="Stage. Drag a part to place it in the mix.">
      <svg class="stage-floor" id="stageFloor" aria-hidden="true"></svg>
      <div class="stage-lbl back">Back of the stage: quieter</div>
      <div class="stage-lbl front">Front of the stage: louder</div>
      <div class="stage-lbl left">Left</div>
      <div class="stage-lbl right">Right</div>
      <div class="stage-hint" id="stageHint" hidden></div>
    </div>
    <div class="stage-foot">
      <div class="stage-card" id="stageCard"></div>
      <div class="stage-acts">
        <button class="pill" id="stAdd">+ Add a part</button>
        <button class="pill" id="stAuto">Arrange for me</button>
      </div>
    </div>`;
  $('#mixWin').after(w);
  $('#stAdd').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); addPartMenu(r.left, r.top - 4, true); };
  $('#stAuto').onclick = autoArrange;

  const sw = $('.win-switch');
  if (sw) { const b = document.createElement('button'); b.id = 'btnStage'; b.title = 'Stage: see your whole song as a band on a stage, and mix by dragging'; b.textContent = 'Stage'; b.onclick = () => setView('stage'); sw.appendChild(b); }
  const bar = $('.creative-bar');
  if (bar) {
    const s = document.createElement('button'); s.id = 'bigStage'; s.className = 'pill icon'; s.title = 'Stage: your song as a band on a stage. Drag parts to mix.';
    s.innerHTML = STAGE_ICON.stage + '<span>Stage</span>'; s.onclick = () => setView(S.view === 'stage' ? 'edit' : 'stage');
    const ws = document.createElement('button'); ws.id = 'bigWhole'; ws.className = 'pill icon'; ws.title = 'Whole song: fit the entire song on the screen, no scrolling';
    ws.innerHTML = STAGE_ICON.whole + '<span>Whole song</span>'; ws.onclick = wholeSong;
    const at = $('#bigCap') || $('#countInBtn');
    bar.insertBefore(s, at); bar.insertBefore(ws, at);
  }
  const z = $('#zoomFit'); if (z) z.title = 'Whole song: fit the entire song on the screen';
})();

const _setViewStage = setView;
setView = function (v) {
  _setViewStage(v);
  $('#stageWin').hidden = v !== 'stage';
  $('#btnStage')?.classList.toggle('active', v === 'stage');
  $('#bigStage')?.classList.toggle('on', v === 'stage');
  if (v === 'stage') {
    renderStage(); stageLoop();
    setTimeout(() => tip('stage', 'This is your band on a stage. Drag a part left or right to place it. Drag it toward the front to make it louder, or toward the back to make it quieter. The strip at the top shows your next step.', '#stageArea'), 300);
  }
};
const _refreshAllStage = refreshAll;
refreshAll = function () { _refreshAllStage(); if (S.view === 'stage') renderStage(); };
new ResizeObserver(() => { if (S.view === 'stage') renderStage(); }).observe($('#stageArea'));

function renderStage() {
  const area = $('#stageArea'); if (!area || area.hidden) return;
  const g = stageGeom(); if (g.w < 50) return;
  // floor
  const bl = g.cx - g.bw, br = g.cx + g.bw, fl = g.cx - g.fw, fr = g.cx + g.fw, top = g.y0 - 22, bot = g.y1 + 22;
  $('#stageFloor').setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
  $('#stageFloor').innerHTML = `
    <defs><linearGradient id="stgFl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c2027"/><stop offset="1" stop-color="#2b313b"/></linearGradient>
    <radialGradient id="stgSpot" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#fff6d61f"/><stop offset="1" stop-color="#fff6d600"/></radialGradient></defs>
    <path d="M${bl - 22} ${top}L${br + 22} ${top}L${fr + 28} ${bot}L${fl - 28} ${bot}Z" fill="url(#stgFl)" stroke="#3b4350"/>
    <path d="M${bl - 22} ${top}L${br + 22} ${top}L${fr + 28} ${bot}L${fl - 28} ${bot}Z" fill="url(#stgSpot)"/>
    ${[0.25, 0.5, 0.75].map(f => { const y = g.y0 + f * (g.y1 - g.y0), hw = g.bw + (g.fw - g.bw) * f + 24; return `<line x1="${g.cx - hw}" y1="${y}" x2="${g.cx + hw}" y2="${y}" stroke="#ffffff0d"/>`; }).join('')}
    <line x1="${g.cx}" y1="${top}" x2="${g.cx}" y2="${bot}" stroke="#ffffff10" stroke-dasharray="4 6"/>`;
  // parts
  area.querySelectorAll('.puck').forEach(p => p.remove());
  const placed = [];
  let overlap = false;
  if (STG.sel && !trackById(STG.sel)) STG.sel = null;
  if (!STG.sel && S.tracks[0]) STG.sel = (selectedTracks()[0] || S.tracks[0]).id;
  for (const tr of S.tracks) {
    const pos = trToStage(tr, g);
    let dx = 0; const near = placed.filter(q => Math.hypot(q.x - pos.x, q.y - pos.y) < 34);
    if (near.length) { dx = (near.length % 2 ? 1 : -1) * Math.ceil(near.length / 2) * 34; if (near.some(q => Math.abs(q.tr.pan - tr.pan) < 0.05 && Math.abs((q.tr.vol === -Infinity ? -99 : q.tr.vol) - (tr.vol === -Infinity ? -99 : tr.vol)) < 1.5)) overlap = true; }
    placed.push({ ...pos, tr });
    const el = document.createElement('div');
    el.className = 'puck' + (tr.id === STG.sel ? ' sel' : '') + (audible(tr) ? '' : ' off') + (tr.solo ? ' solo' : '');
    el.dataset.id = tr.id; el.tabIndex = 0; el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${tr.name}: volume ${volWords(tr.vol)}, ${panWords(tr.pan)}. Drag to move, or use arrow keys.`);
    el.style.left = (pos.x + dx) + 'px'; el.style.top = pos.y + 'px'; el.style.zIndex = 2 + Math.round(pos.f * 20);
    el.style.setProperty('--c', tr.color); el.style.setProperty('--s', (0.78 + 0.34 * pos.f).toFixed(3));
    const ini = tr.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    el.innerHTML = `<div class="pk-dot"><i class="pk-glow"></i><b>${escapeHtml(ini)}</b></div><span class="pk-name">${escapeHtml(tr.name)}</span>`;
    stagePuckEvents(el, tr);
    area.appendChild(el);
  }
  const hint = $('#stageHint');
  if (!S.tracks.length) { hint.hidden = false; hint.innerHTML = 'Your stage is empty. Tap <b>+ Add a part</b> to bring in your first idea.'; }
  else if (overlap) { hint.hidden = false; hint.innerHTML = 'Some parts are standing in the same spot. Tap <b>Arrange for me</b> to spread them out, or drag them apart.'; }
  else hint.hidden = true;
  renderStageCard(); renderJourney();
}

function stagePuckEvents(el, tr) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    const area = $('#stageArea'), r = area.getBoundingClientRect(), g = stageGeom();
    const sx = e.clientX, sy = e.clientY, start = trToStage(tr, g);
    let moved = false;
    el.setPointerCapture(e.pointerId);
    selectStagePart(tr.id);
    const mv = ev => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!moved) { moved = true; pushHistory(); el.classList.add('drag'); }
      const x = clamp(start.x + ev.clientX - sx, 0, r.width), y = clamp(start.y + ev.clientY - sy, 0, r.height);
      const m = stageToMix(x, y, g);
      tr.pan = m.pan; tr.vol = m.db; applyMix(tr); syncHeader(tr); syncStrip(tr);
      const p = trToStage(tr, g);
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.setProperty('--s', (0.78 + 0.34 * p.f).toFixed(3));
      renderStageCard();
    };
    const up = () => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (moved) { STG.mixed = true; el.classList.remove('drag'); status(`${tr.name}: ${volWords(tr.vol)}, ${panWords(tr.pan)}. Undo puts it back.`); renderStage(); }
    };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('keydown', e => {
    const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!step) return;
    e.preventDefault(); e.stopPropagation(); pushHistory();
    tr.pan = clamp(Math.round((tr.pan + step[0]) * 100) / 100, -1, 1);
    if (step[1]) tr.vol = clamp((tr.vol === -Infinity ? -40 : tr.vol) + step[1], -40, 6);
    applyMix(tr); syncHeader(tr); syncStrip(tr); STG.mixed = true; renderStage();
    $(`.puck[data-id="${tr.id}"]`)?.focus();
  });
}
function selectStagePart(id) {
  STG.sel = id; S.sel.tracks = new Set([id]);
  $$('.puck').forEach(p => p.classList.toggle('sel', p.dataset.id === id));
  renderStageCard(); renderHeaders();
}
function renderStageCard() {
  const c = $('#stageCard'); if (!c) return;
  const tr = STG.sel && trackById(STG.sel);
  if (!tr) { c.innerHTML = '<span class="sc-empty">Tap a part on the stage to see it here.</span>'; return; }
  c.innerHTML = `<i style="background:${tr.color}"></i>
    <div class="sc-txt"><b>${escapeHtml(tr.name)}</b><small>Volume ${volWords(tr.vol)} · ${panWords(tr.pan)}</small></div>
    <button class="pill ${tr.solo ? 'on' : ''}" data-a="solo" title="Hear only this part">Solo</button>
    <button class="pill ${tr.mute ? 'on' : ''}" data-a="mute" title="Silence this part">Mute</button>
    <button class="pill" data-a="fx" title="Choose a sound for this part, such as Warm vocal">Sound</button>
    <button class="pill" data-a="name" title="Give this part a new name">Rename</button>
    <button class="pill" data-a="reset" title="Put this part back in the centre at 0 dB">Reset</button>`;
  c.querySelectorAll('button').forEach(b => b.onclick = async e => {
    const a = b.dataset.a;
    if (a === 'solo' || a === 'mute') { await toggleTrackFlag(tr, a, e.altKey); renderStage(); }
    else if (a === 'fx') chainsDialog(tr.id);
    else if (a === 'name') renameTrack(tr);
    else if (a === 'reset') { pushHistory(); tr.pan = 0; tr.vol = 0; applyMix(tr); syncHeader(tr); syncStrip(tr); renderStage(); status(tr.name + ' is back in the centre at 0 dB'); }
  });
}
function stageLoop() {
  cancelAnimationFrame(STG.raf);
  const step = () => {
    if (S.view !== 'stage') return;
    for (const p of $$('.puck')) {
      const ch = live.get(p.dataset.id); if (!ch) continue;
      const lv = meterH(gainToDb(Math.max(ch.peakL || 0, ch.peakR || 0)));
      p.style.setProperty('--lv', lv.toFixed(3));
    }
    STG.raf = requestAnimationFrame(step);
  };
  STG.raf = requestAnimationFrame(step);
}

// ───────────────────────── Arrange for me ─────────────────────────
function partRole(tr) {
  const n = tr.name.toLowerCase();
  if (tr.inst?.type === 'drums' || /drum|kick|snare|beat|perc|kit/.test(n)) return 'drums';
  if (/bass/.test(n)) return 'bass';
  if (/vocal|vox|voice|sing|lead|lyric|melody/.test(n)) return 'vocal';
  return 'other';
}
function autoArrange() {
  if (!S.tracks.length) return status('Add a part first');
  pushHistory();
  const spots = [-0.55, 0.55, -0.8, 0.8, -0.3, 0.3, -0.95, 0.95];
  let k = 0;
  const lone = S.tracks.length === 1;
  for (const tr of S.tracks) {
    const role = lone ? 'vocal' : partRole(tr);
    if (role === 'vocal') { tr.pan = 0; tr.vol = -1; }
    else if (role === 'drums') { tr.pan = 0; tr.vol = -13; }
    else if (role === 'bass') { tr.pan = 0.15; tr.vol = -7; }
    else { tr.pan = spots[k % spots.length]; tr.vol = -9; k++; }
    applyMix(tr); syncHeader(tr); syncStrip(tr);
  }
  STG.mixed = true;
  renderStage();
  status('Arranged like a band: the lead part in front, drums and bass behind it, other parts left and right. Undo puts it back.');
}

// ───────────────────────── Add a part ─────────────────────────
function addPartMenu(x, y, above) {
  const items = [
    { label: 'Sing or play into the microphone', action: () => addPart('mic') },
    { label: 'Drums (pads, TD-17 or keyboard)', action: () => addPart('drums') },
    { label: 'Keys or synth (MIDI keyboard)', action: () => addPart('synth') },
    { label: 'Bring in a sound file', action: () => $('#fileIn').click() },
  ];
  showDropdown(items, x, y);
  if (above) { const d = $('#dropdown'); d.style.top = Math.max(30, y - d.offsetHeight) + 'px'; }
}
function addPart(kind) {
  pushHistory();
  const tr = kind === 'mic' ? newTrack(nextIdeaName()) : makeInstTrack(kind, kind === 'synth' ? 'Keys' : 'Drums');
  S.tracks.forEach(t => { t.arm = false; }); tr.arm = true;
  S.sel.tracks = new Set([tr.id]); STG.sel = tr.id;
  refreshAll();
  const btn = $('#bigRec') && $('#bigRec').offsetParent ? $('#bigRec') : $('#tpRec');
  btn?.classList.add('nudge'); setTimeout(() => btn?.classList.remove('nudge'), 6000);
  status(`${tr.name} is ready. Tap Record when you are ready to play. PrePro counts you in.`);
  if (kind !== 'mic') midiEnsure?.(true);
}

// ───────────────────────── Whole song ─────────────────────────
function wholeSong() {
  if (S.view !== 'edit') setView('edit');
  setTimeout(() => {
    const avail = $('#editBody').clientHeight - 6, n = Math.max(1, S.tracks.length);
    const h = [140, 96, 56].find(v => v * n <= avail) || 56;
    S.tracks.forEach(t => { t.h = h; });
    $('#editBody').scrollTop = 0;
    sizeCanvases(); renderHeaders(); zoomFit();
    status(sessionEnd() ? 'Showing the whole song' : 'Your song is empty. Record something and it will show here.');
  }, 0);
}

// ───────────────────────── Song Journey ─────────────────────────
const JOURNEY = [
  { k: 'catch', label: 'Catch it', hint: 'Record or Capture your idea',
    done: () => S.tracks.some(t => t.clips.length),
    go: () => { setView('edit'); const b = $('#bigRec')?.offsetParent ? $('#bigRec') : $('#tpRec'); b?.classList.add('nudge'); setTimeout(() => b?.classList.remove('nudge'), 6000); status('Tap Record to catch your idea. Or tap Capture to keep what you just played.'); } },
  { k: 'build', label: 'Build it', hint: 'Add more parts',
    done: () => S.tracks.filter(t => t.clips.length).length >= 2,
    go: () => { const r = $('#journey [data-k="build"]').getBoundingClientRect(); addPartMenu(r.left, r.bottom + 4); } },
  { k: 'shape', label: 'Shape it', hint: 'Mark verse and chorus',
    done: () => S.markers.filter(m => isSection(m)).length >= 2,
    go: () => { const r = $('#journey [data-k="shape"]').getBoundingClientRect(); sectionMenu(r.left, r.bottom + 4); } },
  { k: 'mix', label: 'Mix it', hint: 'Place parts on the stage',
    done: () => STG.mixed || S.tracks.some(t => Math.abs(t.pan) > 0.01),
    go: () => { if (S.view !== 'stage') setView('stage'); else autoArrange(); } },
  { k: 'share', label: 'Share it', hint: 'Export, or send to your engineer',
    done: () => STG.shared,
    go: () => { const r = $('#journey [data-k="share"]').getBoundingClientRect(); showDropdown([
      { label: 'Export my song as a WAV file', action: () => { if (!sessionEnd()) return status('Record something first, then export it'); S.sel.end = S.sel.start; bounce(); } },
      { label: 'Send to Engineer…', action: sendToEngineerDialog },
      { label: 'Save a version of this song…', action: versionsDialog },
    ], r.left, r.bottom + 4); } },
];
function renderJourney() {
  const j = $('#journey'); if (!j) return;
  const st = JOURNEY.map(s => !!s.done());
  const next = st.indexOf(false);
  j.innerHTML = JOURNEY.map((s, i) => `<button role="listitem" data-k="${s.k}" class="jy ${st[i] ? 'done' : ''} ${i === next ? 'next' : ''}" title="${s.hint}">
    <span class="jy-n">${st[i] ? STAGE_ICON.check : i + 1}</span><span class="jy-t"><b>${s.label}</b><small>${i === next ? 'Next: ' + s.hint : s.hint}</small></span></button>`).join('');
  j.querySelectorAll('.jy').forEach(b => b.onclick = () => JOURNEY.find(s => s.k === b.dataset.k).go());
}
const _bounceStage = bounce;
bounce = async function () { const r = await _bounceStage.apply(this, arguments); STG.shared = true; if (S.view === 'stage') renderJourney(); return r; };
const _bepStage = buildEngineerPackage;
buildEngineerPackage = async function () { const r = await _bepStage.apply(this, arguments); STG.shared = true; if (S.view === 'stage') renderJourney(); return r; };

// ───────────────────────── Always-visible status: what PrePro is doing right now ─────────────────────────
(() => {
  const s = $('#status'); if (!s) return;
  const d = document.createElement('div'); d.className = 'tp-state'; d.id = 'tpState'; d.setAttribute('aria-live', 'polite');
  d.innerHTML = '<span class="st-dot"></span><b>Stopped</b>';
  s.before(d);
  let last = '';
  setInterval(() => {
    let k = 'stopped', t = 'Stopped';
    if (T.recording) { k = 'rec'; t = 'Recording'; }
    else if (typeof counting !== 'undefined' && counting) { k = 'count'; t = 'Counting in'; }
    else if (T.playing) { k = 'play'; t = S.loop ? 'Playing (loop)' : 'Playing'; }
    else if (T.recArmed) { k = 'armed'; t = 'Ready to record'; }
    const key = k + t;
    if (key !== last) { last = key; d.className = 'tp-state ' + k; d.querySelector('b').textContent = t; }
  }, 150);
})();

// ───────────────────────── Menus and keys ─────────────────────────
const _viewMenuStage = MENUS.view;
MENUS.view = () => [
  { label: 'Edit', checked: S.view === 'edit', action: () => setView('edit') },
  { label: 'Mix', checked: S.view === 'mix', action: () => setView('mix') },
  { label: 'Stage', checked: S.view === 'stage', action: () => setView('stage') },
  { label: 'Whole Song', k: 'Shift+W', action: wholeSong },
  { sep: true },
  ..._viewMenuStage(),
];
{ const _sc = showShortcuts;
  showShortcuts = function () {
    _sc();
    $('#modal .keys')?.insertAdjacentHTML('beforeend', [['Shift+W', 'Whole song on screen'], ['Shift+B', 'Stage view on or off'], ['Arrows on a part', 'Move it on the Stage']].map(([a, b]) => `<kbd>${a}</kbd><span>${b}</span>`).join(''));
  }; }
document.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (!$('#modalBack').hidden) return;
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'W' || e.key === 'w')) { e.preventDefault(); e.stopPropagation(); wholeSong(); }
  else if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'B' || e.key === 'b')) { e.preventDefault(); e.stopPropagation(); setView(S.view === 'stage' ? 'edit' : 'stage'); }
}, true);

// Edit and Mix switch you can always see (on phones the toolbar buttons are off screen)
{ const b = document.createElement('button');
  b.id = 'viewFlip'; b.className = 'view-flip'; b.type = 'button';
  document.body.appendChild(b);
  const sync = () => { const toMix = S.view !== 'mix'; b.innerHTML = toMix ? '<span aria-hidden="true">&#9776;</span> Mix' : '<span aria-hidden="true">&#9636;</span> Edit';
    b.title = (toMix ? 'Go to the Mix window' : 'Go to the Edit window') + ' (Ctrl+=)'; b.setAttribute('aria-label', b.title); };
  b.onclick = () => { setView(S.view === 'mix' ? 'edit' : 'mix'); };
  const _sv = setView; setView = function (v) { _sv(v); sync(); };
  sync();
  const place = () => { const t = document.querySelector('.transport'); b.style.bottom = ((t ? t.getBoundingClientRect().height : 56) + 10) + 'px'; };
  place(); addEventListener('resize', place);
}
