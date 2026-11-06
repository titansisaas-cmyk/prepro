// Clip toolbar: appears when a clip is selected. Trim, split, fade and delete in one tap.
// Simple mode: tap a clip to select it; the play position moves to where you tapped,
// so "Trim start" and "Trim end" cut at that spot.
const CT_ICON = {
  trimL: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M7 3v14M10 6h7v8h-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trimR: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M13 3v14M10 6H3v8h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 7l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  split: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M10 2v16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M2 6h5v8H2M18 6h-5v8h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  fadeIn: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M2 16L11 5h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fadeOut: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M2 5h7l9 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  del: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const clipBar = document.createElement('div');
clipBar.id = 'clipBar'; clipBar.className = 'clip-bar'; clipBar.hidden = true;
clipBar.setAttribute('role', 'toolbar'); clipBar.setAttribute('aria-label', 'Clip tools');
clipBar.innerHTML = `
  <span class="cb-name" id="cbName"></span>
  <button data-ct="trimL" title="Trim start: remove everything before the play position">${CT_ICON.trimL}<span>Trim start</span></button>
  <button data-ct="trimR" title="Trim end: remove everything after the play position">${CT_ICON.trimR}<span>Trim end</span></button>
  <button data-ct="split" title="Split the clip in two at the play position">${CT_ICON.split}<span>Split</span></button>
  <button data-ct="fadeIn" title="Fade in: start softly. Tap again to remove.">${CT_ICON.fadeIn}<span>Fade in</span></button>
  <button data-ct="fadeOut" title="Fade out: end softly. Tap again to remove.">${CT_ICON.fadeOut}<span>Fade out</span></button>
  <div class="cb-gain" role="group" aria-label="Clip volume">
    <button data-ct="gainDn" title="Make this clip quieter (1 dB)" aria-label="Quieter">−</button>
    <span id="cbGain" title="Clip volume. Tap to reset to 0 dB.">0 dB</span>
    <button data-ct="gainUp" title="Make this clip louder (1 dB)" aria-label="Louder">+</button>
  </div>
  <button data-ct="del" class="cb-del" title="Delete this clip">${CT_ICON.del}<span>Delete</span></button>
  <button data-ct="close" class="cb-x" title="Done" aria-label="Done">✕</button>`;
document.body.appendChild(clipBar);

const ctClips = () => [...S.selClips].map(findClip).filter(Boolean);
const ctHere = () => S.playhead;   // the play position, which moves to where you tap

function clipTool(kind) {
  const list = ctClips();
  if (kind === 'close') { S.selClips.clear(); dirty(); return syncClipBar(); }
  if (!list.length) return syncClipBar();
  if (kind === 'del') { cmdDelete(); return syncClipBar(); }
  if (kind === 'gainUp' || kind === 'gainDn' || kind === 'gain0') {
    pushHistory();
    for (const { c } of list) c.gain = kind === 'gain0' ? 0 : clamp(Math.round(((c.gain || 0) + (kind === 'gainUp' ? 1 : -1)) * 10) / 10, -36, 24);
    dirty(); const g = list[0].c.gain || 0;
    status(kind === 'gain0' ? 'Clip volume back to 0 dB' : (kind === 'gainUp' ? 'Louder: ' : 'Quieter: ') + (g > 0 ? '+' : '') + g + ' dB. The waveform shows the change.');
    return syncClipBar();
  }
  const live = list.filter(f => !f.c.locked);
  if (!live.length) return status('This clip is locked (Clip > Lock / Unlock)');
  const t = ctHere();
  if (kind === 'trimL' || kind === 'trimR' || kind === 'split') {
    const inside = live.filter(({ c }) => t > c.start + 0.01 && t < c.start + c.dur - 0.01);
    if (!inside.length) return status('Tap inside the clip where you want to cut, then choose ' + ({ trimL: 'Trim start', trimR: 'Trim end', split: 'Split' })[kind]);
    pushHistory();
    for (const { tr, c } of inside) {
      if (kind === 'trimL') { const d = t - c.start; c.start = t; c.offset += d; c.dur -= d; c.fadeIn = Math.min(Math.max(0, c.fadeIn - d), c.dur / 2); }
      else if (kind === 'trimR') { c.dur = t - c.start; c.fadeOut = Math.min(c.fadeOut, c.dur / 2); }
      else { const parts = splitClip(tr, c, t); if (parts) S.selClips = new Set([parts[1].id]); }
    }
    dirty(); renderClipList();
    status(kind === 'trimL' ? 'Trimmed the start' : kind === 'trimR' ? 'Trimmed the end' : 'Split the clip in two. The right half is selected.');
    return syncClipBar();
  }
  if (kind === 'fadeIn' || kind === 'fadeOut') {
    const key = kind, on = live.some(({ c }) => !(c[key] > 0));
    pushHistory();
    for (const { c } of live) c[key] = on ? Math.min(c.dur / 3, Math.max(0.15, Math.min(1, c.dur / 4))) : 0;
    dirty();
    status(on ? (kind === 'fadeIn' ? 'Added a fade in' : 'Added a fade out') + '. Drag the top corner of the clip to make it longer or shorter.' : 'Removed the fade');
    return syncClipBar();
  }
}
clipBar.querySelectorAll('[data-ct]').forEach(b => b.onclick = e => { e.stopPropagation(); clipTool(b.dataset.ct); });
$('#cbGain').onclick = e => { e.stopPropagation(); clipTool('gain0'); };

function syncClipBar() {
  const list = ctClips();
  const show = list.length > 0 && !T.recording;
  clipBar.hidden = !show;
  document.body.classList.toggle('has-clipbar', show);
  if (!show) return;
  $('#cbName').textContent = list.length === 1 ? list[0].c.name : list.length + ' clips';
  const g = list[0].c.gain || 0;
  $('#cbGain').textContent = (g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g) + ' dB';
  clipBar.querySelector('[data-ct="fadeIn"]').classList.toggle('on', list.every(f => f.c.fadeIn > 0));
  clipBar.querySelector('[data-ct="fadeOut"]').classList.toggle('on', list.every(f => f.c.fadeOut > 0));
  const t = ctHere(), inside = list.some(({ c }) => t > c.start + 0.01 && t < c.start + c.dur - 0.01);
  ['trimL', 'trimR', 'split'].forEach(k => clipBar.querySelector(`[data-ct="${k}"]`).classList.toggle('dim', !inside));
  // sit just above the bottom play controls
  const tp = $('.transport')?.getBoundingClientRect();
  const bottom = tp ? Math.round(innerHeight - tp.top + 8) : 64;
  clipBar.style.bottom = bottom + 'px';
  document.body.style.setProperty('--cb-top', (bottom + clipBar.offsetHeight + 8) + 'px');
}

// Simple mode: a tap on a clip (without dragging) selects that clip and marks the spot.
// Uses the click event, which comes after the studio's own mouse handling on phones and computers.
{
  let down = null;
  lanes.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; }, true);
  lanes.addEventListener('click', e => {
    const d = down; down = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return syncClipBar();
    if (S.simple && Math.abs(S.sel.end - S.sel.start) < 0.001) {
      const r = lanes.getBoundingClientRect(), h = hitTest(e.clientX - r.left, e.clientY - r.top);
      if (h && h.c) {
        S.selClips = new Set([h.c.id]); S.sel.tracks = new Set([h.tr.id]);
        if (!T.playing) { const t = clamp(h.t, h.c.start, h.c.start + h.c.dur); S.playhead = S.sel.start = S.sel.end = t; }
        renderHeaders(); dirty();
      }
    }
    syncClipBar();
  });
}
setInterval(syncClipBar, 300);
addEventListener('resize', () => syncClipBar());
