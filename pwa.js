/* PrePro on every device: install to the home screen or desktop (iPhone, iPad, Android, Windows, Mac, Chromebook, Linux),
   offline support, and the legal pages (Terms, Licence, Privacy, Refunds, Disclaimers). */
'use strict';

const LEGAL_URL = 'legal.html';
const LEGAL_VERSION = '1.0';
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
const UA = navigator.userAgent;
const PLATFORM = (() => {
  if (/iPhone|iPod/.test(UA)) return 'iphone';
  if (/iPad/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ipad';
  if (/Android/.test(UA)) return 'android';
  if (/Mac/.test(UA)) return 'mac';
  if (/Windows/.test(UA)) return 'windows';
  if (/CrOS/.test(UA)) return 'chromebook';
  return 'desktop';
})();
const BROWSER = /Edg\//.test(UA) ? 'edge' : /CriOS|Chrome\//.test(UA) && !/OPR\//.test(UA) ? 'chrome' : /FxiOS|Firefox\//.test(UA) ? 'firefox' : /Safari\//.test(UA) ? 'safari' : 'other';

// offline support
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
// keep the screen awake while recording on phones (where supported)
let wakeLock = null;
setInterval(async () => {
  const need = T.recording || T.playing;
  if (need && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') { try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) {} }
  else if (!need && wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
}, 1000);

// ───────────────────────── Install ─────────────────────────
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { installEvt = null; status('PrePro is installed. Open it from your home screen or apps, like any other app.'); });

const SHARE_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" style="vertical-align:-3px"><path d="M10 2v11M6 6l4-4 4 4M4 10v7h12v-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function installSteps() {
  if (PLATFORM === 'iphone' || PLATFORM === 'ipad') {
    if (BROWSER !== 'safari' && BROWSER !== 'chrome' && BROWSER !== 'edge') return ['Open this page in <b>Safari</b>.', `Tap the <b>Share</b> button ${SHARE_ICON}.`, 'Tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.'];
    return [
      `Tap the <b>Share</b> button ${SHARE_ICON}. In Safari it is at the bottom of the screen${PLATFORM === 'ipad' ? ' or at the top right' : ''}. In Chrome it is in the address bar.`,
      'Scroll down and tap <b>Add to Home Screen</b>. If you do not see it, tap <b>Edit Actions</b> and add it.',
      'Make sure <b>Open as Web App</b> is on, then tap <b>Add</b>.',
      'Open PrePro from its new icon on your home screen.',
    ];
  }
  if (PLATFORM === 'android') return ['Tap the <b>three dots</b> menu at the top right of Chrome.', 'Tap <b>Add to Home screen</b>, then <b>Install</b>.', 'Open PrePro from its new icon.'];
  if (PLATFORM === 'mac' && BROWSER === 'safari') return ['In the menu bar at the top of the screen, click <b>File</b>.', 'Click <b>Add to Dock</b>, then <b>Add</b>.', 'Open PrePro from the Dock.'];
  if (BROWSER === 'firefox') return ['Firefox cannot install web apps on computers yet.', 'Open this page in <b>Chrome</b> or <b>Edge</b>, then choose Install PrePro again.', 'Or bookmark this page to come back to it.'];
  return ['Click the <b>Install</b> icon at the right end of the address bar. It looks like a small screen with a down arrow.', 'Or open the browser menu and choose <b>Install PrePro</b> (in Edge: Apps, then Install this site as an app).', 'Open PrePro from your apps, Start menu or Dock.'];
}
function installDialog() {
  if (isStandalone()) return openModal('PrePro is installed', '<p class="mic-one">You are using the installed PrePro app. It works offline too, and it updates itself when you are online.</p>', [{ label: 'Close', primary: true }]);
  const can = !!installEvt;
  const steps = installSteps();
  const m = openModal('Install PrePro on this device', `
    <p class="mic-one">PrePro installs like an app on iPhone, iPad, Android phones and tablets, Windows, Mac and Chromebook. It gets its own icon, opens full screen, and works offline. It is free to install, and your songs stay on this device.</p>
    ${can ? '<p class="mic-small">Tap <b>Install now</b> below.</p>' : `<ol class="inst-steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>`}
    <p class="mic-small">Installing means you agree to the <a href="${LEGAL_URL}#terms" target="_blank" rel="noopener">Terms of Use</a> and <a href="${LEGAL_URL}#privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>`,
    can ? [{ label: 'Not now' }, { label: 'Install now', primary: true, action: async () => { const e = installEvt; installEvt = null; e.prompt(); try { await e.userChoice; } catch (x) {} } }] : [{ label: 'Close', primary: true }]);
  m.classList.add('inst-modal');
}

// ───────────────────────── Legal ─────────────────────────
const openLegal = sec => window.open(LEGAL_URL + (sec ? '#' + sec : ''), '_blank', 'noopener');
const LEGAL_FOOT = `<p class="legal-foot">By using PrePro you agree to the <a href="${LEGAL_URL}#terms" target="_blank" rel="noopener">Terms of Use and Licence</a> and <a href="${LEGAL_URL}#privacy" target="_blank" rel="noopener">Privacy Policy</a>. &copy; 2026 Red Road Innovation Group Inc.</p>`;

function decorateWelcome() {
    const card = $('#welcome .wc-card'); if (!card || card.querySelector('.legal-foot')) return;
    const links = card.querySelector('.wc-links');
    if (links && !isStandalone()) { const b = document.createElement('button'); b.textContent = 'Install PrePro on this device'; b.onclick = e => { e.stopPropagation(); $('#welcome')?.remove(); setSimple(PREF.get('simple', true), true); installDialog(); }; links.appendChild(b); }
    card.insertAdjacentHTML('beforeend', LEGAL_FOOT);
    PREF.set('legalSeen', LEGAL_VERSION);
}
{ const _sw = showWelcome; showWelcome = function () { _sw(); decorateWelcome(); }; }
decorateWelcome();

// buying a plan requires agreeing to the Terms and Refund Policy (click to accept)
{ const _pd = plansDialog;
  plansDialog = function () {
    _pd();
    const md = $('#modal'); if (!md) return;
    const plans = md.querySelector('.plans'); if (!plans) return;
    const ok = PREF.get('legalAccepted') === LEGAL_VERSION;
    plans.insertAdjacentHTML('afterend', `<label class="wf-check legal-agree"><input type="checkbox" id="legalOk" ${ok ? 'checked' : ''}> <span>I agree to the <a href="${LEGAL_URL}#terms" target="_blank" rel="noopener">Terms of Use and Licence</a>, the <a href="${LEGAL_URL}#refunds" target="_blank" rel="noopener">Refund Policy</a> and the <a href="${LEGAL_URL}#privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>`);
    md.querySelectorAll('[data-buy]').forEach(b => {
      const go = b.onclick;
      b.onclick = e => { if (!$('#legalOk').checked) { status('Please tick the box to agree to the Terms first'); $('#legalOk').closest('label').classList.add('nudge'); return; } PREF.set('legalAccepted', LEGAL_VERSION); go(e); };
    });
  }; }
{ const _ad = accountDialog;
  accountDialog = function () { _ad(); $('#modal .body')?.insertAdjacentHTML('beforeend', LEGAL_FOOT); }; }

function aboutDialog() {
  openModal('About PrePro', `<p class="mic-one">PrePro takes a song from the first idea to the finished mix. Catch ideas in the rehearsal room or on the go, then record, edit, mix and share them, with a full studio for engineers and a simple mode for creatives.</p>
    <p class="mic-small">Songs are saved on this device. The AI assistant runs on your own AI account. PrePro works in the browser and installs as an app on iPhone, iPad, Android, Windows, Mac and Chromebook.</p>
    <p class="mic-small">PrePro is owned and licensed by Red Road Innovation Group Inc. It is an independent product and is not affiliated with or endorsed by Avid (Pro Tools), Slate Digital, Roland, Apple or Google. All trademarks belong to their owners.</p>
    <p class="mic-small"><a href="${LEGAL_URL}#terms" target="_blank" rel="noopener">Terms of Use and Licence</a> · <a href="${LEGAL_URL}#privacy" target="_blank" rel="noopener">Privacy Policy</a> · <a href="${LEGAL_URL}#refunds" target="_blank" rel="noopener">Refund Policy</a> · <a href="${LEGAL_URL}#disclaimers" target="_blank" rel="noopener">Disclaimers</a></p>
    <p class="mic-small">&copy; 2026 Red Road Innovation Group Inc. All rights reserved.</p>`, [{ label: 'Close', primary: true }]);
}
MENUS.help = (orig => () => {
  const items = orig().map(it => it.label === 'About PrePro' ? { ...it, action: aboutDialog } : it);
  return [...items, { sep: true },
    { label: isStandalone() ? 'PrePro Is Installed' : 'Install PrePro on This Device…', action: installDialog },
    { sep: true },
    { label: 'Terms of Use and Licence', action: () => openLegal('terms') },
    { label: 'Privacy Policy', action: () => openLegal('privacy') },
    { label: 'Refund Policy', action: () => openLegal('refunds') },
    { label: 'Legal Disclaimers and Trademarks', action: () => openLegal('disclaimers') }];
})(MENUS.help);
