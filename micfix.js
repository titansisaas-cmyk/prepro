/* iPhone and iPad microphone fixes.
   1. While a web page has the microphone open, iOS turns the built-in speaker down a lot.
      PrePro now closes the microphone as soon as a recording ends, so playback returns to full volume.
   2. The audio session is set to play-and-record before the microphone opens, and back to playback after.
   3. Quiet takes are raised automatically with clip volume (never destructive, and the clip buttons can change it). */
'use strict';

const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const setAudioSession = t => { try { if (navigator.audioSession) navigator.audioSession.type = t; } catch (e) {} };
async function bounceContext() { if (!IS_IOS) return; try { await ctx.suspend(); await ctx.resume(); } catch (e) {} }

{ const _em = ensureMic;
  ensureMic = async function (...a) {
    const had = !!micStream;
    if (!had) setAudioSession('play-and-record');
    const ok = await _em(...a);
    if (!ok && !had) setAudioSession('playback');
    if (ok && !had) await bounceContext();
    return ok;
  }; }

function releaseMic() {
  if (!micStream) return;
  if (CAP.listening) { if (CAP.src && CAP.node) { try { CAP.src.disconnect(CAP.node); } catch (e) {} } CAP.listening = false; CAP.src = null; CAP.chunks = []; syncCapture(); }
  for (const [id, g] of monitorTaps) { try { g.disconnect(); } catch (e) {} monitorTaps.delete(id); }
  try { micSource && micSource.disconnect(); } catch (e) {}
  micStream.getTracks().forEach(t => t.stop());
  micStream = null; micSource = null; micAnalyser = null;
  setAudioSession('playback');
  bounceContext();
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
