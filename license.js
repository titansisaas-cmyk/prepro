// PrePro plans, license keys and My Account.
// Payments, tax, license keys and the billing portal are handled by Lemon Squeezy (merchant of record).
// The License API needs no secret key and allows browser calls, so PrePro needs no server of its own.
// To switch payments on, fill in LICENSE_CFG with the IDs and checkout links from the Lemon Squeezy dashboard.

const LICENSE_CFG = {
  storeId: null,                 // e.g. 123456 (Settings > Stores)
  productId: null,               // the "PrePro Pro" product ID
  variants: { monthly: null, yearly: null, lifetime: null },   // variant IDs
  checkout: { monthly: '', yearly: '', lifetime: '' },         // Share > checkout links
  storeUrl: '',                  // e.g. https://prepro.lemonsqueezy.com (billing portal is storeUrl + '/billing')
  deviceLimit: 3,
};
const PLANS = [
  { id: 'free', name: 'Free', price: '$0', per: 'forever', lead: 'Catch ideas anywhere',
    items: ['Record, play and edit in Simple mode', `Up to ${4} tracks per song`, `Keep up to ${5} songs on this device`, 'Beat starter and count-in', 'Export your song as a WAV file'] },
  { id: 'monthly', name: 'Pro Monthly', price: '$9.99', per: 'USD per month', lead: 'The full studio',
    items: ['Everything in Free', 'Pro mode: the full editing toolkit', 'Unlimited tracks and songs', 'MIDI: Roland TD-17, keyboards, MIDI files', 'PrePro AI (with your own AI account)', 'Up to 3 devices'] },
  { id: 'yearly', name: 'Pro Yearly', price: '$89', per: 'USD per year', lead: 'Save 25 percent', best: true,
    items: ['Everything in Pro Monthly', 'Two months free compared with monthly'] },
  { id: 'lifetime', name: 'Founder Lifetime', price: '$249', per: 'USD once', lead: 'Pay once, keep Pro',
    items: ['Everything in Pro, forever', 'All future updates', 'Founder supporter badge'] },
];
const FREE_LIMITS = { tracks: 4, songs: 5 };
const ENFORCE = !!LICENSE_CFG.storeId;
const LS_API = 'https://api.lemonsqueezy.com/v1/licenses/';
const MY_ORDERS = 'https://app.lemonsqueezy.com/my-orders';

// ?plan=free previews the free plan before payments are switched on
const PREVIEW_FREE = /[?&]plan=free\b/.test(location.search);
let LIC = PREF.get('license', null);   // { key, instanceId, plan, status, name, email, expires, checked, limit, usage }

function isPro() {
  if (!ENFORCE) return !PREVIEW_FREE;
  if (!LIC || !LIC.key) return false;
  if (!['active', 'inactive'].includes(LIC.status)) return false;
  if (LIC.expires && Date.parse(LIC.expires) < Date.now()) return false;
  // offline grace: 14 days since the last successful check
  return Date.now() - (LIC.checked || 0) < 14 * 864e5;
}
const planName = () => isPro() ? (PLANS.find(p => p.id === LIC?.plan)?.name || (ENFORCE ? 'Pro' : 'Pro preview')) : 'Free';

async function lsCall(action, params) {
  const r = await fetch(LS_API + action, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}
function belongsToPrePro(meta) {
  if (!meta) return false;
  if (LICENSE_CFG.storeId && +meta.store_id !== +LICENSE_CFG.storeId) return false;
  if (LICENSE_CFG.productId && +meta.product_id !== +LICENSE_CFG.productId) return false;
  return true;
}
function planFromVariant(id) {
  for (const k in LICENSE_CFG.variants) if (LICENSE_CFG.variants[k] && +LICENSE_CFG.variants[k] === +id) return k;
  return 'monthly';
}
function storeLicense(j, key, instanceId) {
  LIC = { key, instanceId, plan: planFromVariant(j.meta.variant_id), status: j.license_key.status, name: j.meta.customer_name, email: j.meta.customer_email,
    expires: j.license_key.expires_at, limit: j.license_key.activation_limit, usage: j.license_key.activation_usage, checked: Date.now() };
  PREF.set('license', LIC); syncPlanBadge();
}
async function activateLicense(key) {
  key = key.trim();
  if (!key) return 'Paste your license key first.';
  try {
    const name = (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone or iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Computer') + ' · ' + new Date().toLocaleDateString();
    const { j } = await lsCall('activate', { license_key: key, instance_name: name });
    if (!j.activated) return j.error === 'license_key not found.' ? 'That key was not found. Check it against your receipt email.' : (j.error || 'That key could not be activated.');
    if (!belongsToPrePro(j.meta)) return 'That key is for a different product.';
    storeLicense(j, key, j.instance.id);
    return null;
  } catch (e) { return 'PrePro could not reach the license service. Check your internet connection and try again.'; }
}
async function validateLicense() {
  if (!ENFORCE || !LIC?.key) return;
  try {
    const { j } = await lsCall('validate', { license_key: LIC.key, instance_id: LIC.instanceId || '' });
    if (j.valid && belongsToPrePro(j.meta)) storeLicense(j, LIC.key, LIC.instanceId);
    else if (j.license_key || j.error) { LIC.status = j.license_key?.status || 'disabled'; PREF.set('license', LIC); syncPlanBadge(); }
  } catch (e) { /* offline: keep the grace period */ }
}
async function deactivateLicense() {
  if (LIC?.key && LIC.instanceId) { try { await lsCall('deactivate', { license_key: LIC.key, instance_id: LIC.instanceId }); } catch (e) {} }
  LIC = null; PREF.set('license', null); syncPlanBadge();
  if (!isPro() && !S.simple) setSimple(true, true);
}

// ───────────────────────── Upgrade prompts ─────────────────────────
const FEATURE_TEXT = {
  pro: ['Pro mode', 'The full studio: every editing tool, the clip list and the detailed mixer.'],
  midi: ['MIDI', 'Play and record with your Roland TD-17, a keyboard or any MIDI device, and import or export MIDI files.'],
  ai: ['PrePro AI', 'Ask for bass lines, beats and mix ideas in plain words, using your own AI account.'],
  tracks: ['More tracks', `The Free plan includes up to ${FREE_LIMITS.tracks} tracks per song. Pro has no limit.`],
  songs: ['More songs', `The Free plan keeps up to ${FREE_LIMITS.songs} songs on this device. Pro has no limit. You can still save this one as a file with File > Save Song File.`],
};
function needPro(feature) {
  if (isPro()) return false;
  const [title, text] = FEATURE_TEXT[feature];
  openModal(`${title} is part of PrePro Pro`, `<p class="mic-one">${text}</p><p class="mic-small">Plans start at $9.99 USD a month. Your songs stay yours on every plan.</p>`,
    [{ label: 'Not now' }, { label: 'See plans', primary: true, action: () => setTimeout(plansDialog, 0) }]);
  return true;
}

// ───────────────────────── Plans and My Account ─────────────────────────
function buy(planId) {
  const url = LICENSE_CFG.checkout[planId];
  if (!url) return status('Payments are not switched on yet');
  window.open(url + (url.includes('?') ? '&' : '?') + 'checkout[custom][source]=prepro-app', '_blank');
  setTimeout(() => status('After you pay, your license key arrives by email. Paste it in My Account to unlock Pro.'), 600);
}
function plansDialog() {
  const cur = isPro() ? (LIC?.plan || 'monthly') : 'free';
  const cards = PLANS.map(p => `<div class="plan${p.best ? ' best' : ''}${p.id === cur && (ENFORCE || p.id === 'free') ? ' current' : ''}">
      ${p.best ? '<span class="plan-flag">Best value</span>' : ''}
      <h4>${p.name}</h4><div class="plan-price">${p.price}<small>${p.per}</small></div><p class="plan-lead">${p.lead}</p>
      <ul>${p.items.map(i => `<li>${i}</li>`).join('')}</ul>
      ${p.id === 'free' ? `<button disabled>${cur === 'free' ? 'Your plan' : 'Included'}</button>`
        : `<button class="primary" data-buy="${p.id}" ${LICENSE_CFG.checkout[p.id] ? '' : 'disabled title="Payments are not switched on yet"'}>${ENFORCE && p.id === cur ? 'Your plan' : 'Choose ' + p.name}</button>`}
    </div>`).join('');
  const m = openModal('PrePro plans', `<p class="plan-intro">Start free. Upgrade when your idea needs the full studio. Prices in US dollars; sales tax is added at checkout where it applies.</p>
    <div class="plans">${cards}</div>
    ${ENFORCE ? '' : '<p class="mic-small">Payments are not switched on yet, so every Pro feature is open for now.</p>'}
    <p class="mic-small">Already paid? <a href="#" data-acct>Enter your license key</a>.</p>`, [{ label: 'Close', primary: true }]);
  m.classList.add('wide');
  m.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => buy(b.dataset.buy));
  m.querySelector('[data-acct]').onclick = e => { e.preventDefault(); accountDialog(); };
}
function accountDialog() {
  const pro = isPro();
  const masked = LIC?.key ? LIC.key.slice(0, 4) + '••••••••' + LIC.key.slice(-4) : '';
  let body;
  if (pro && LIC?.key) {
    body = `<div class="acct">
      <div class="acct-row"><span>Plan</span><b>${planName()}</b></div>
      ${LIC.name ? `<div class="acct-row"><span>Name</span><b>${escapeHtml(LIC.name)}</b></div>` : ''}
      ${LIC.email ? `<div class="acct-row"><span>Email</span><b>${escapeHtml(LIC.email)}</b></div>` : ''}
      <div class="acct-row"><span>License key</span><b class="mono">${masked}</b></div>
      <div class="acct-row"><span>Devices</span><b>${LIC.usage || 1} of ${LIC.limit || LICENSE_CFG.deviceLimit}</b></div>
      ${LIC.expires ? `<div class="acct-row"><span>Renews or ends</span><b>${new Date(LIC.expires).toLocaleDateString()}</b></div>` : ''}
      <div class="acct-row"><span>Last checked</span><b>${new Date(LIC.checked).toLocaleString()}</b></div>
    </div>
    <p class="mic-small">Change your plan, update your card, download invoices or cancel in the billing portal.</p>`;
  } else {
    body = `<p class="mic-one">You are on <b>${planName()}</b>.${!ENFORCE && pro ? ' Payments are not switched on yet, so every Pro feature is open for now.' : ''}</p>
      <div class="acct-key"><input id="licKey" placeholder="Paste your license key" autocomplete="off" spellcheck="false"><button class="primary" id="licGo">Activate</button></div>
      <p class="acct-msg" id="licMsg"></p>
      <p class="mic-small">Your key is in the receipt email you got after paying. Lost it? <a href="${MY_ORDERS}" target="_blank" rel="noopener">Find it in My Orders</a> by signing in with your email.</p>`;
  }
  const btns = pro && LIC?.key
    ? [{ label: 'Remove from this device', action: () => { deactivateLicense().then(() => { status('This device no longer uses your Pro license'); }); } },
       { label: 'Check now', action: () => { validateLicense().then(() => accountDialog()); return false; } },
       { label: 'Billing portal', primary: true, action: () => { LICENSE_CFG.storeUrl ? window.open(LICENSE_CFG.storeUrl.replace(/\/$/, '') + '/billing', '_blank') : window.open(MY_ORDERS, '_blank'); return false; } }]
    : [{ label: 'See plans', action: () => setTimeout(plansDialog, 0) }, { label: 'Close', primary: true }];
  const m = openModal('My Account', body, btns);
  const go = m.querySelector('#licGo');
  if (go) go.onclick = async () => {
    const msg = m.querySelector('#licMsg'); go.disabled = true; msg.textContent = 'Checking your key…';
    const err = ENFORCE ? await activateLicense(m.querySelector('#licKey').value) : 'Payments are not switched on yet, so there is nothing to activate.';
    go.disabled = false;
    if (err) { msg.textContent = err; msg.classList.add('bad'); return; }
    status('PrePro Pro is unlocked on this device. Thank you for supporting PrePro.');
    accountDialog();
  };
}

// account button in the toolbar, next to Save
const acctBtn = document.createElement('button');
acctBtn.id = 'btnAccount'; acctBtn.title = 'My Account and plans';
$('#btnSave').parentNode.insertBefore(acctBtn, $('#btnSave'));
acctBtn.onclick = () => accountDialog();
function syncPlanBadge() {
  const pro = isPro();
  acctBtn.className = pro ? 'acct-btn pro' : 'acct-btn';
  acctBtn.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14"><circle cx="10" cy="7" r="3.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.8 17c.8-3.2 3.3-4.8 6.2-4.8s5.4 1.6 6.2 4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>${pro ? 'Pro' : 'Upgrade'}`;
}
syncPlanBadge();

// ───────────────────────── Feature gates ─────────────────────────
{ const o = setSimple; setSimple = function (on, quiet) { if (!on && needPro('pro')) return; return o(on, quiet); }; }
{ const o = midiSetupDialog; midiSetupDialog = function (...a) { if (needPro('midi')) return; return o(...a); }; }
{ const o = importMidiFile; importMidiFile = function (...a) { if (needPro('midi')) return; return o(...a); }; }
{ const o = exportMidi; exportMidi = function (...a) { if (needPro('midi')) return; return o(...a); }; }
{ const o = toggleAI; toggleAI = function (force) { if (force !== false && needPro('ai')) return; return o(force); }; }
{ const o = newTrackDialog; newTrackDialog = function (...a) { if (!isPro() && S.tracks.length >= FREE_LIMITS.tracks) return needPro('tracks'); return o(...a); }; }
{ const o = writeSong; writeSong = async function (silent) {
    if (!isPro()) {
      const list = await Lib.list().catch(() => []);
      if (!list.some(s => s.id === S.songId) && list.length >= FREE_LIMITS.songs) { if (!silent) needPro('songs'); return; }
    }
    return o(silent);
  }; }

// menus: Help > My Account, Help > Plans
MENUS.help = (orig => () => [...(orig ? orig() : []), { sep: true }, { label: 'My Account…', action: accountDialog }, { label: 'PrePro Plans…', action: plansDialog }])(MENUS.help);

// boot: stay in Simple mode on the free plan, refresh the license once a day
if (!isPro() && !S.simple) setSimple(true, true);
if (LIC?.key && Date.now() - (LIC.checked || 0) > 864e5) validateLicense();
