# PrePro: Plans, Licensing and Revenue Model

PrePro is pre-production in your pocket: catch the idea in the rehearsal room or on the go, then take it all the way to a finished song. The business model follows the same path. The idea stage is free, and the finishing studio is paid.

## The plans

| Plan | Price (USD) | Who it is for | What it includes |
|---|---|---|---|
| Free | $0 | Songwriters catching ideas | Record, play and edit in Simple mode; up to 4 tracks per song; up to 5 songs saved on the device; beat starter; count-in; WAV export |
| Pro Monthly | $9.99 per month | Creators finishing songs | Everything in Free, plus Pro mode (full editing toolkit), unlimited tracks and songs, MIDI (Roland TD-17, keyboards, MIDI files), PrePro AI, up to 3 devices |
| Pro Yearly | $89 per year | Committed users | Everything in Pro Monthly, about 25 percent less than paying monthly |
| Founder Lifetime | $249 once | Early supporters and engineers | Pro forever, all future updates, founder badge |

### Why these prices

- Pro Tools Studio is listed at $34.99 USD per month ([Avid](https://www.avid.com/pro-tools)), and its perpetual license sells for about $599 ([ProAudioStar](https://www.proaudiostar.com/studio-recording/pro-tools/pro-tools-software.html)).
- BandLab Membership is $14.99 per month or $149.99 per year on the App Store ([Toolradar](https://toolradar.com/guides/best-free-daw-software)).
- At $9.99 per month, PrePro is clearly cheaper than both, while offering professional editing, MIDI drum support and AI that most mobile tools lack.
- The Founder Lifetime plan brings in cash early and rewards the first people who believe in PrePro. It can be retired once the first wave of users arrives.

### Why the free plan stops where it does

The free plan gives a songwriter everything needed to capture an idea, so they fall in love with PrePro. The upgrade appears at the exact moment the idea grows into a song: a fifth track, a sixth saved song, the full editing toolkit, the drum kit over MIDI, or the AI assistant. Each upgrade message explains in one line what the feature does, and states that songs stay the user's on every plan.

## How licensing works

PrePro uses Lemon Squeezy as the merchant of record. Lemon Squeezy takes the payment, charges and files sales tax and VAT, emails the customer a license key, and gives every customer a billing portal ([Lemon Squeezy Customer Portal](https://www.lemonsqueezy.com/features/customer-portal)).

1. The customer taps Upgrade in PrePro and chooses a plan.
2. Lemon Squeezy checkout opens. The customer pays.
3. The receipt email contains a license key.
4. The customer opens My Account in PrePro, pastes the key, and taps Activate.
5. PrePro checks the key with the Lemon Squeezy License API ([License API docs](https://docs.lemonsqueezy.com/api/license-api)). It confirms the key belongs to the PrePro store and product, as Lemon Squeezy recommends ([license key guide](https://docs.lemonsqueezy.com/guides/tutorials/license-keys)), and records this device.
6. Pro unlocks on that device. PrePro rechecks the key once a day and keeps working offline for up to 14 days.
7. When a subscription ends or is cancelled, the key expires and PrePro returns to the Free plan. Songs are never deleted.

Each key works on up to 3 devices. A customer can remove a device in My Account to free up a slot.

## The user portal (My Account)

- **Free users:** see their current plan, paste a license key, view all plans, and get a link to Lemon Squeezy My Orders to recover a lost key.
- **Pro users:** see plan, name, email, masked license key, devices used, renewal date and last check. Buttons: Billing portal (change plan, update card, invoices, cancel), Check now, and Remove from this device.

## Revenue math

Lemon Squeezy charges 5 percent plus 50 cents per transaction. It adds 0.5 percent on subscription payments and 1.5 percent on international or PayPal payments ([Lemon Squeezy fees](https://docs.lemonsqueezy.com/help/getting-started/fees)). There is no monthly fee.

| Plan | Price | Approximate fee (US buyer) | You keep |
|---|---|---|---|
| Pro Monthly | $9.99 | $1.05 | about $8.94 per month |
| Pro Yearly | $89.00 | $5.40 | about $83.60 per year |
| Founder Lifetime | $249.00 | $12.95 | about $236.05 once |

Illustration for a first year: 200 monthly subscribers, 100 yearly subscribers and 50 founders would bring in about $41,600 USD after fees. This is an example of the math, not a forecast.

## What is built and live

- Free and Pro plans, enforced in the app.
- Upgrade prompts for Pro mode, MIDI, AI, extra tracks and extra songs.
- Plans screen, My Account portal, license activation, daily recheck, offline grace and device removal.
- Upgrade button in the toolbar, and My Account and Plans in the Help menu.

Until the payment store is connected, PrePro stays in an open preview with every Pro feature unlocked, so nothing breaks for current testers. Adding `?plan=free` to the address shows exactly what free users will see.

## What is needed to start charging

1. Create a Lemon Squeezy account at [lemonsqueezy.com](https://www.lemonsqueezy.com) and finish identity and payout setup.
2. Create a store named PrePro.
3. Create a product named PrePro Pro with three variants: Monthly ($9.99, subscription), Yearly ($89, subscription) and Founder Lifetime ($249, single payment).
4. Switch on "Generate license keys" with an activation limit of 3. For the two subscriptions, let the key follow the subscription.
5. Send me the store ID, product ID, the three variant IDs, the three checkout links, and the store address. I will switch payments on, and the free plan starts that day.

Note: Lemon Squeezy is part of Stripe and is moving toward Stripe Managed Payments ([Lemon Squeezy 2026 update](https://www.lemonsqueezy.com/blog/2026-update)). If new Lemon Squeezy stores are not accepted, the same plan can run on Paddle or Stripe with small changes.

## Honest limits and next steps

- Because PrePro runs entirely in the browser, a determined technical user could get around the checks. This is normal for a first version. A small server can be added later to make the checks much harder to get around.
- Before charging, PrePro needs Terms of Service, a refund policy and a privacy policy. I can draft all three.
- Future revenue ideas: a Band plan for shared projects, paid sound packs and drum kits, and a referral reward for creators who bring in other creators.
