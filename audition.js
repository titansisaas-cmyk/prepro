/* PrePro "Try before you keep": hear effects on a part, on a loop, before adding them.
   Tap through options while the part plays, compare Before and After, then Keep or Cancel.
   Nothing changes in the song until Keep is tapped, and Keep can be undone. */
'use strict';

const beatMs = () => beatSec() * 1000;
// Ready-made versions of each effect, so there is something good to hear straight away.
const AUD_PRESETS = () => ({
  delay: [
    ['Slap back', { time: 110, feedback: 8, tone: 6000, mix: 22 }],
    ['Echo on the beat', { time: Math.round(beatMs()), feedback: 30, tone: 5000, mix: 22 }],
    ['Dotted echo', { time: Math.round(beatMs() * 0.75), feedback: 35, tone: 4500, mix: 22 }],
    ['Long echo', { time: Math.min(1500, Math.round(beatMs() * 2)), feedback: 45, tone: 3500, mix: 24 }],
  ],
  reverb: [
    ['Small room', { decay: 0.8, predelay: 5, tone: 8000, mix: 18 }],
    ['Plate', { decay: 1.8, predelay: 20, tone: 7000, mix: 22 }],
    ['Big hall', { decay: 3.5, predelay: 35, tone: 5500, mix: 28 }],
    ['Huge space', { decay: 6.5, predelay: 50, tone: 4500, mix: 32 }],
  ],
  comp: [
    ['Gentle', { threshold: -16, ratio: 2.5, knee: 10, attack: 15, release: 150, makeup: 3 }],
    ['Strong', { threshold: -26, ratio: 5, knee: 6, attack: 8, release: 120, makeup: 7 }],
    ['Squashed', { threshold: -34, ratio: 12, knee: 3, attack: 2, release: 80, makeup: 11 }],
  ],
  eq: [
    ['Brighter', { low: 0, lowF: 120, mid: 0, midF: 1000, q: 1, high: 4, highF: 8000 }],
    ['Warmer', { low: 3, lowF: 150, mid: 0, midF: 1000, q: 1, high: -2.5, highF: 8000 }],
    ['Less boxy', { low: 0, lowF: 120, mid: -5, midF: 400, q: 1.2, high: 1, highF: 9000 }],
    ['More presence', { low: -1, lowF: 120, mid: 3.5, midF: 3000, q: 1, high: 1, highF: 10000 }],
  ],
  filter: [
    ['Old radio', { type: 'bandpass', freq: 1500, q: 1.2 }],
    ['Darker', { type: 'lowpass', freq: 2800, q: 0.7 }],
    ['Thinner', { type: 'highpass', freq: 350, q: 0.7 }],
  ],
  trim: [['Louder', { gain: 6, phase: 'off' }], ['Quieter', { gain: -6, phase: 'off' }]],
});
const AUD_GROUPS = [['delay', 'Echo'], ['reverb', 'Space'], ['comp', 'Punch'], ['eq', 'Tone'], ['filter', 'Filter'], ['trim', 'Volume']];
const AUD_COLORS = { delay: '#3f7fd0', reverb: '#7a5bc7', comp: '#c9583f', eq: '#2f9a6a', filter: '#b8861e', trim: '#5c6670', chain: '#2a6f9e' };

let AUD = null;
const cloneIns = ins => JSON.parse(JSON.stringify(ins));
function setInsertsLive(tr, inserts) {
  tr.inserts = cloneIns(inserts);
  while (tr.inserts.length < 5) tr.inserts.push(null);
  const ch = live.get(tr.id);
  if (ch) ch.plugins.forEach((p, i) => { if (p) { try { p.output.disconnect(); } catch (e) {} ch.plugins[i] = null; } });
  rewire(tr);
}
// the part of the song to loop: the selection, or up to 4 bars of this part from the play position
function auditionRange(tr) {
  if (S.sel.end - S.sel.start > 0.5) return [S.sel.start, S.sel.end];
  const cs = [...tr.clips].sort((a, b) => a.start - b.start);
  if (!cs.length) return null;
  const at = S.sel.start;
  const c = cs.find(c => at >= c.start && at < c.start + c.dur) || cs.find(c => c.start >= at) || cs[0];
  const start = at >= c.start && at < c.start + c.dur ? at : c.start;
  const len = Math.max(1, Math.min(c.start + c.dur - start, 4 * barSec()));
  return [start, start + len];
}

function openAudition(tr, mode, slot, pre) {
  tr = tr || selectedTracks()[0] || S.tracks[0];
  if (!tr) return status('Add a part first');
  if (mode === 'slot' && (slot == null || slot < 0)) { slot = tr.inserts.findIndex(x => !x); if (slot < 0) slot = 4; }
  if (AUD) endAudition(false);
  AUD = { tr, mode, slot, orig: cloneIns(tr.inserts), cand: null, choice: null, after: true, started: false,
    saved: { loop: S.loop, start: S.sel.start, end: S.sel.end, solos: S.tracks.map(t => [t.id, t.solo]) }, kept: false };
  const range = auditionRange(tr);
  const name = escapeHtml(tr.name);
  let opts = '';
  if (mode === 'slot') {
    const P = AUD_PRESETS();
    opts = AUD_GROUPS.map(([k, label]) => `<div class="aud-g"><span class="aud-gl">${S.simple ? label : PLUGINS[k].name}</span><div class="chips">${P[k].map(([n], i) => `<button data-t="${k}" data-i="${i}" style="background:${AUD_COLORS[k]}">${n}</button>`).join('')}</div></div>`).join('');
  } else {
    const all = [...userChains(), ...CHAIN_FACTORY];
    AUD.chains = all;
    opts = `<div class="chips">${all.map((c, i) => `<button data-c="${i}" style="background:${AUD_COLORS.chain}">${escapeHtml(c.name)}</button>`).join('')}</div>`;
  }
  const m = openModal(mode === 'slot' ? 'Try an effect' : 'Try a sound', `
    <p class="mic-small aud-intro">${range ? `PrePro is playing <b>${name}</b> on a loop. Tap a choice to hear it. Nothing is added until you tap <b>Keep</b>.` : `<b>${name}</b> has no recording yet. You can still choose a sound now, and you will hear it when you record.`}</p>
    <div class="aud-ctl">
      <div class="aud-ab" role="group" aria-label="Compare"><button id="audBefore">Before</button><button id="audAfter" class="on">After</button></div>
      <button id="audPlay" class="aud-play">${range ? 'Stop' : 'Play'}</button>
      <label class="wf-check aud-solo"><input type="checkbox" id="audSolo"> Hear only this part</label>
    </div>
    <div class="aud-opts">${opts}</div>
    <div class="aud-now" id="audNow">Nothing chosen yet</div>
    <div class="row aud-amt" id="audAmtRow" hidden><label>Amount</label><input type="range" id="audAmt" min="0" max="100" step="1"><output id="audAmtO"></output></div>`,
    [{ label: 'Cancel', action: () => { endAudition(false); } },
     ...(mode === 'slot' ? [{ label: 'Keep and fine-tune', action: () => { if (!AUD?.cand) { status('Tap a choice first'); return false; } const t = AUD.tr, sl = AUD.slot; endAudition(true); setTimeout(() => openPlugin(t, sl), 0); } }] : []),
     { label: 'Keep', primary: true, action: () => { if (!AUD?.cand) { status('Tap a choice first, or tap Cancel'); return false; } endAudition(true); } }]);
  m.classList.add('aud-modal');
  m.querySelectorAll('.aud-opts button').forEach(b => b.onclick = () => {
    m.querySelectorAll('.aud-opts button').forEach(x => x.classList.toggle('sel', x === b));
    if (b.dataset.t) chooseEffect(b.dataset.t, +b.dataset.i, b.textContent);
    else chooseChain(+b.dataset.c);
  });
  $('#audBefore').onclick = () => setAB(false);
  $('#audAfter').onclick = () => setAB(true);
  $('#audSolo').onchange = e => { if (!AUD) return; AUD.tr.solo = e.target.checked; if (!e.target.checked) AUD.saved.solos.forEach(([id, s]) => { const t = trackById(id); if (t && t !== AUD.tr) t.solo = s; }); else S.tracks.forEach(t => { if (t !== AUD.tr) t.solo = false; }); applyAllMix(); renderHeaders(); };
  $('#audPlay').onclick = () => { if (T.playing) { stop(); $('#audPlay').textContent = 'Play'; } else { startAuditionLoop(); } };
  $('#audAmt').oninput = e => {
    if (!AUD?.cand || AUD.mode !== 'slot') return;
    const ins = AUD.cand[AUD.slot]; ins.params.mix = +e.target.value; $('#audAmtO').textContent = e.target.value + '%';
    const p = live.get(AUD.tr.id)?.plugins[AUD.slot]; if (p && p.set && AUD.after) p.set(ins.params);
    if (AUD.after) AUD.tr.inserts[AUD.slot] = cloneIns(ins);
  };
  if (pre != null && mode === 'chain') m.querySelector(`[data-c="${pre}"]`)?.click();
  if (range) startAuditionLoop();
}
function startAuditionLoop() {
  if (!AUD) return;
  const r = auditionRange(AUD.tr) || [AUD.saved.start, AUD.saved.start + 4 * barSec()];
  S.loop = true; S.sel.start = r[0]; S.sel.end = r[1];
  if (T.playing) stop();
  AUD.started = true;
  play(); updateTransportUI();
  const b = $('#audPlay'); if (b) b.textContent = 'Stop';
}
function chooseEffect(type, i, label) {
  const [, params] = AUD_PRESETS()[type][i];
  const cand = cloneIns(AUD.orig);
  while (cand.length < 5) cand.push(null);
  cand[AUD.slot] = { type, bypass: false, params: { ...defaultParams(type), ...params } };
  AUD.cand = cand; AUD.choice = (S.simple ? AUD_GROUPS.find(g => g[0] === type)[1] : PLUGINS[type].name) + ': ' + label;
  const hasMix = 'mix' in cand[AUD.slot].params;
  $('#audAmtRow').hidden = !hasMix;
  if (hasMix) { $('#audAmt').value = cand[AUD.slot].params.mix; $('#audAmtO').textContent = cand[AUD.slot].params.mix + '%'; }
  setAB(true);
}
function chooseChain(i) {
  const c = AUD.chains[i];
  const ins = c.inserts.map(x => x && PLUGINS[x.type] ? { type: x.type, bypass: !!x.bypass, params: { ...defaultParams(x.type), ...cloneIns(x.params || {}) } } : null);
  while (ins.length < 5) ins.push(null);
  AUD.cand = ins.slice(0, 5); AUD.choice = c.name;
  $('#audAmtRow').hidden = true;
  setAB(true);
}
function setAB(after) {
  if (!AUD) return;
  AUD.after = after;
  $('#audBefore')?.classList.toggle('on', !after); $('#audAfter')?.classList.toggle('on', after);
  if (!AUD.cand) { $('#audNow').textContent = after ? 'Nothing chosen yet' : 'Before: how it sounds now'; return; }
  setInsertsLive(AUD.tr, after ? AUD.cand : AUD.orig);
  $('#audNow').innerHTML = after ? `Hearing: <b>${escapeHtml(AUD.choice)}</b>` : 'Hearing: <b>Before</b>, how it sounds without it';
}
function endAudition(keep) {
  const A = AUD; if (!A) return;
  AUD = null;
  if (A.started && T.playing) stop();
  // put everything back as it was, then (if keeping) apply the choice as one undoable step
  setInsertsLive(A.tr, A.orig);
  A.saved.solos.forEach(([id, s]) => { const t = trackById(id); if (t) t.solo = s; });
  applyAllMix();
  S.loop = A.saved.loop; S.sel.start = A.saved.start; S.sel.end = A.saved.end;
  if (keep && A.cand) {
    pushHistory();
    setInsertsLive(A.tr, A.cand);
    status(`${A.tr.name} now has ${A.choice}. Undo takes it back.`);
    if (typeof STG !== 'undefined') STG.mixed = true;
  } else status('No changes made to ' + A.tr.name);
  renderMixer(); refreshAll();
}
// closing the window with the X, the Escape key or a tap outside counts as Cancel
new MutationObserver(() => { if (AUD && $('#modalBack').hidden) endAudition(false); }).observe($('#modalBack'), { attributes: true, attributeFilter: ['hidden'] });

// ───────────────────────── Where it appears ─────────────────────────
// Mix window: an empty effects slot opens Try an effect (Simple), or offers it first (Pro)
const _slotClickAud = slotClick;
slotClick = function (obj, i, btn, e) {
  if (obj.id === 'master' || obj.inserts[i] || e.altKey) return _slotClickAud(obj, i, btn, e);
  if (S.simple) return openAudition(obj, 'slot', i);
  const r = btn.getBoundingClientRect();
  const items = [{ label: 'Try and Compare…', action: () => openAudition(obj, 'slot', i) }, { sep: true },
    ...Object.entries(PLUGINS).map(([k, p]) => ({ label: p.name, action: () => { obj.inserts[i] = { type: k, bypass: false, params: defaultParams(k) }; rewire(obj); renderMixer(); openPlugin(obj, i); } }))];
  showDropdown(items, r.left, r.bottom + 2);
};
// Effect Chains window: every chain gets a Try button
const _chainsDialogAud = chainsDialog;
chainsDialog = function (trId) {
  _chainsDialogAud(trId);
  const md = $('#modal'); if (!md) return;
  const all = [...userChains(), ...CHAIN_FACTORY];
  md.querySelectorAll('[data-use]').forEach(b => {
    const t = document.createElement('button'); t.textContent = 'Try'; t.title = 'Hear it on a loop before you keep it';
    t.onclick = () => { const tr = trackById($('#chTrack').value); const idx = +b.dataset.use; $('#modalBack').hidden = true; setTimeout(() => openAudition(tr, 'chain', null, idx), 0); };
    b.before(t);
  });
};
// Stage: the Sound button opens Try a sound
if (typeof renderStageCard === 'function') {
  const _rsc = renderStageCard;
  renderStageCard = function () {
    _rsc();
    const b = $('#stageCard [data-a="fx"]'); if (!b) return;
    b.onclick = () => { const tr = trackById(STG.sel); if (tr) openAudition(tr, 'chain'); };
    if (!$('#stageCard [data-a="tryfx"]')) {
      const e = document.createElement('button'); e.className = 'pill'; e.dataset.a = 'tryfx'; e.textContent = 'Effects'; e.title = 'Try one effect, such as echo or space, before you keep it';
      e.onclick = () => { const tr = trackById(STG.sel); if (tr) openAudition(tr, 'slot'); };
      b.after(e);
    }
  };
}
MENUS.track = (orig => () => [...orig(), { label: 'Try Effects on This Track…', action: () => openAudition(selectedTracks()[0], 'slot') }, { label: 'Try Sounds on This Track…', action: () => openAudition(selectedTracks()[0], 'chain') }])(MENUS.track);
if (typeof MENU_FRIENDLY !== 'undefined') Object.assign(MENU_FRIENDLY, { 'Try Effects on This Track…': 'Try an Effect (hear it first)…', 'Try Sounds on This Track…': 'Try a Sound (hear it first)…' });
