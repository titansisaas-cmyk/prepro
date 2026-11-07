/* iPhone and iPad microphone fixes.
   1. While a web page has the microphone open, iOS turns the built-in speaker down a lot.
      PrePro now closes the microphone as soon as a recording ends, so playback returns to full volume.
   2. PrePro leaves the iPhone audio mode on automatic. Switching it during a session made iOS go silent while the meters kept moving.
   3. Quiet takes are raised automatically with clip volume (never destructive, and the clip buttons can change it). */
'use strict';

const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const setAudioSession = t => { try { if (navigator.audioSession && navigator.audioSession.type !== t) navigator.audioSession.type = t; } catch (e) {} };
async function bounceContext() { try { if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 400))]); } catch (e) {} }

// Every microphone request goes through here. If iOS refuses because of the audio mode, it resets the mode to automatic
// and tries again. It also retries once without a saved
// input device, because iPhone input IDs change between launches.
if (navigator.mediaDevices?.getUserMedia) {
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function (c) {
    try { return await gum(c); }
    catch (e) {
      const dev = c && c.audio && typeof c.audio === 'object' && c.audio.deviceId;
      if (dev && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError' || e.name === 'NotReadableError')) {
        S.audioIn = ''; const a = { ...c.audio }; delete a.deviceId; return gum({ ...c, audio: a });
      }
      if (e.name === 'InvalidStateError') { setAudioSession('auto'); return gum(c); }
      throw e;
    }
  };
}
const micLive = () => { const t = micStream && micStream.getAudioTracks()[0]; return !!t && t.readyState === 'live' && !t.muted; };
function dropMic() {
  try { micSource && micSource.disconnect(); } catch (e) {}
  try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  micStream = null; micSource = null; micAnalyser = null;
}

{ const _em = ensureMic;
  ensureMic = async function (...a) {
    if (micStream && !micLive()) dropMic();   // iOS may end or mute the input after a call, Siri or the app going to the background
    const ok = await _em(...a);
    if (ok) {
      await bounceContext();
      const t = micStream && micStream.getAudioTracks()[0];
      if (t && !t._ppWatch) { t._ppWatch = true; t.addEventListener('mute', () => { if (T.recording) status('iPhone paused the microphone. Stop, then record again.'); }); }
    }
    return ok;
  }; }

function releaseMic() {
  if (!micStream) return;
  if (CAP.listening) { if (CAP.src && CAP.node) { try { CAP.src.disconnect(CAP.node); } catch (e) {} } CAP.listening = false; CAP.src = null; CAP.chunks = []; syncCapture(); }
  for (const [id, g] of monitorTaps) { try { g.disconnect(); } catch (e) {} monitorTaps.delete(id); }
  try { micSource && micSource.disconnect(); } catch (e) {}
  micStream.getTracks().forEach(t => t.stop());
  micStream = null; micSource = null; micAnalyser = null;
}
// on iPhone, keep the microphone open only while it is needed
const keepMicOpen = () => CAP.listening || S.tracks.some(t => t.inputMon) || T.recording || T.recArmed || counting;
{ const _stopL = stopListening;
  stopListening = function () { _stopL(); if (IS_IOS && !keepMicOpen()) releaseMic(); }; }

// after each recording: raise quiet takes, warn about silent ones, then release the mic on iPhone
{ const _fr = finishRecording;
  finishRecording = function (endPos) {
    const armed = S.tracks.filter(t => t.arm && t.kind !== 'inst');
    const before = new Set(armed.flatMap(t => t.clips.map(c => c.id)));
    const rec = recorder;
    _fr(endPos);
    if (!rec || !rec.onstop) { if (IS_IOS && !keepMicOpen()) releaseMic(); return; }
    const o = rec.onstop;
    rec.onstop = async (...x) => {
      await o(...x);
      let msg = null;
      for (const tr of armed) for (const c of tr.clips) {
        if (before.has(c.id) || c.type === 'midi') continue;
        const b = buffers.get(c.bufId); if (!b) continue;
        const pk = clipPeak(b.buffer, c.offset, c.dur);
        if (pk < 0.0035) msg = 'PrePro heard almost nothing. Check that Safari may use the microphone (tap aA in the address bar, then Website Settings), and that nothing is covering the microphone.';
        else if (PREF.get('autoLevel', true) && pk < 0.18) {
          const g = clamp(Math.round(20 * Math.log10(0.6 / pk)), 1, 24);
          c.gain = g; msg = msg || `Your take was quiet, so PrePro raised it by ${g} dB. Use the clip volume buttons to change it.`;
        }
      }
      if (msg) { status(msg); refreshAll(); dirty(); }
      if (IS_IOS && !keepMicOpen()) releaseMic();
    };
  }; }
function clipPeak(buf, off, dur) {
  let pk = 0; const sr = buf.sampleRate, a = Math.floor(off * sr), z = Math.min(buf.length, Math.floor((off + dur) * sr));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = a; i < z; i += 7) { const v = Math.abs(d[i]); if (v > pk) pk = v; } }
  return pk;
}
// if a take was armed but nothing was recorded (stop during count-in), still release
{ const _stop = stop;
  stop = function (...a) { const r = _stop(...a); if (IS_IOS) setTimeout(() => { if (!keepMicOpen() && !recorder?.state?.startsWith('rec')) releaseMic(); }, 600); return r; }; }

// Capture on iPhone: explain the quieter speaker once
{ const _sl = startListening;
  startListening = async function (quiet) {
    const ok = await _sl(quiet);
    if (ok && IS_IOS && !quiet) tip('capvol', 'While Capture is listening, iPhone turns its speaker down so the microphone does not hear it. Use headphones for full volume, or tap Event, then Stop Listening, when you are done.', '#bigCap');
    return ok;
  }; }
MENUS.options = (orig => () => [...orig(), { label: 'Raise Quiet Takes Automatically', checked: PREF.get('autoLevel', true), action: () => PREF.set('autoLevel', !PREF.get('autoLevel', true)) }])(MENUS.options);

// a few seconds into a take, make sure sound is really arriving
setInterval(() => {
  if (!T.recording || !micAnalyser) { recCheck.t = 0; return; }
  if (!recCheck.t) { recCheck.t = performance.now(); recCheck.max = 0; recCheck.warned = false; }
  const d = new Float32Array(micAnalyser.fftSize); micAnalyser.getFloatTimeDomainData(d);
  for (let i = 0; i < d.length; i += 4) recCheck.max = Math.max(recCheck.max, Math.abs(d[i]));
  if (!recCheck.warned && performance.now() - recCheck.t > 3000 && recCheck.max < 0.0005) {
    recCheck.warned = true;
    status(micLive() ? 'PrePro is not hearing anything yet. Sing or play a little louder, and check that nothing covers the microphone.' : 'The microphone is not sending sound. Stop, then press Record again.');
  }
}, 250);
const recCheck = { t: 0, max: 0, warned: false };

// iPhone playback safety: wake the audio engine on every tap (iOS can pause it after recording, a call or the lock screen),
// and never let Play wait forever on a paused engine.
const wakeAudio = () => { if (ctx.state !== 'running') { try { ctx.resume(); } catch (e) {} } };
['pointerdown', 'touchend', 'keydown'].forEach(ev => window.addEventListener(ev, wakeAudio, { capture: true, passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeAudio(); });
async function engineReady() {
  if (ctx.state === 'running') return true;
  await Promise.race([ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 700))]);
  if (ctx.state === 'running') return true;
  try { await Promise.race([ctx.suspend().then(() => ctx.resume()), new Promise(r => setTimeout(r, 700))]); } catch (e) {}
  return ctx.state === 'running';
}
{ const _play = play;
  play = async function (...a) {
    if (T.playing) return _play(...a);
    const ok = await engineReady();
    if (!ok) { status('iPhone paused the sound. Tap Play again. If it stays silent, close PrePro and open it again.'); return; }
    const r = await _play(...a);
    return r;
  }; }

// Silent switch: iPhone mutes Web Audio when the phone is on silent, unless a normal media element is playing.
// A tiny silent loop started on the first tap tells iOS this is media, so songs play with the ringer off.
// This uses WebKit's own audio mode choice, so the microphone still works.
if (IS_IOS) {
  const silentWav = (() => { const n = 4410, b = new ArrayBuffer(44 + n * 2), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' })); })();
  const keep = document.createElement('audio');
  keep.src = silentWav; keep.loop = true; keep.setAttribute('playsinline', ''); keep.setAttribute('x-webkit-airplay', 'deny'); keep.preload = 'auto';
  const unmute = () => { if (keep.paused && !document.hidden) keep.play().catch(() => {}); };
  ['pointerdown', 'touchend', 'keydown'].forEach(ev => window.addEventListener(ev, unmute, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) keep.pause(); });
}
