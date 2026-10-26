# Taproot on Google Play: the closed test and the listing text

Companion to `PLAY_STORE.md`. Everything on the repository's side is done and measured (2026-10-26, below). What
remains is in the Play Console and takes calendar time, so this page is the plan for the next three weeks and the
text to paste.

## Measured 2026-10-26
- `https://taproot.possessio.io/manifest.webmanifest` → 200, `application/manifest+json`.
- `https://taproot.possessio.io/sw.js` → 200, `application/javascript`.
- `https://taproot.possessio.io/.well-known/assetlinks.json` → 200, `application/json`, the three Play fingerprints.
- Google's Digital Asset Links API lists all three fingerprints for `io.taproot.possessio`
  (`digitalassetlinks.googleapis.com/v1/statements:list`).
- `https://taproot.possessio.io/privacy.html` answers 308 to `/privacy`, which is 200. **Give Play the final URL,
  `https://taproot.possessio.io/privacy`.**
- Google's own page, read through browse.py: personal developer accounts created after 2023-11-13 must run a closed
  test with at least 12 testers opted in continuously for 14 days before they can apply for production access;
  Google's review of the application usually takes seven days or less. Internal testing is optional; open testing
  only after production access. (Play Console Help, "App testing requirements for new personal developer accounts".)
- `npm test`: 112/112 pass.

## Where we got to (from the session log, 2026-10-20)
- Personal Play developer account, verified 2026-10-19. The Play Console had already locked Taproot's package name
  to `io.taproot.possessio` from an earlier upload; every bundle has to carry it.
- PWABuilder took three builds that night: the form resets to its defaults, two came out unsigned or misnamed. The
  third, signed, with Start URL `/seal`, version `1.1.0`, version code 2, was **accepted by the Play Console at about
  17:22 UTC** on the internal testing release page, with the release notes below.
- Play's three signing certificates were downloaded at 17:15 UTC; the asset-links file went live that night (PR #14) and
  Google's API confirmed all three fingerprints by 23:45 UTC.
- **12 tester Gmail addresses** were collected by 22:18 UTC (the minimum; 15 to 20 is the safe number) for the closed
  testing track's email list. The Farcaster tester card and cast text were made ("Shipped by Possessio.io").
- **Where it stopped, 23:50 UTC:** the closed test could not be sent for review because a new app's **"Set up your
  app" checklist** on the dashboard has to be complete first: privacy policy, app access, ads, content rating, target
  audience, data safety, financial features, government apps, category and contact, store listing. The answers are
  below. After the checklist: Closed testing → Review release → Start rollout, then Publishing overview → Send changes
  for review. The opt-in link, `https://play.google.com/apps/testing/io.taproot.possessio`, works only once Google's
  review clears, and the 14 days count only while 12 or more testers are opted in and installed at the same time.
- Not known from here: whether the checklist was finished, whether the closed test was sent for review, and how many
  testers have opted in. Those three facts set the calendar below.

## Before the clock starts: the device check
Google's page "Device verification requirements for new developer accounts" (read through browse.py 2026-10-26): a new
personal account must prove it has a real Android phone before an app can go live. Play Console (web) → Home → the task
"Verify that you have access to an Android mobile device" → View details → scan the QR code with the phone → the Play
Console mobile app → sign in as the account owner → Verify. Five minutes. If the task is not on your Home page, it is
already done.

## The clock
The closed test is the long pole. Nothing else here takes more than an afternoon.

| Day | What |
|---|---|
| D | Closed testing → create a release with the current `.aab`, add a tester list (12 or more emails, or a Google Group), roll out, copy the opt-in link. Send the invitation below. |
| D to D+2 | Chase until 12 people show as opted in on the track page. The 14 days count only while 12 or more stay opted in. |
| D+14 | Dashboard → Apply for production. Answer the three sections: the test, the app, production readiness. Keep tester feedback notes to summarise. |
| D+14 to D+21 | Google reviews. Production and open testing unlock on approval. |

If D is 2026-10-27, apply on 2026-11-10 and expect production around 2026-11-17.

## Tester invitation (text or email, your words to change)
> I'm putting my app, Taproot, on Google Play, and Google makes new developers run a 14-day test with 12 people before
> an app can go public. Could you be one of the 12? It takes two minutes and nothing else:
> 1. On your Android phone, open this link: [paste the closed-test opt-in link from the Play Console].
> 2. Tap "Become a tester", then install Taproot from the Play link on that page.
> 3. Leave it installed and stay opted in for 14 days. Opening it once helps; using it is optional.
> I'll let you know when the 14 days are up. Thank you.

Where 12 people come from: family and friends, anyone who has used Seal, the people you talk Base with on
Farcaster. Ask 16 so that 12 hold.

## Store listing text (Step 5)
**App name:** Taproot
**Short description** (80 max, this is 57): `Seal documents with your wallet. Proof on Base for $0.02.`
**Full description** (4,000 max; the Seal paragraphs are the ones proven on a phone on 2026-10-20):

Seal a document with your wallet, and prove it on Base.

SEAL, LIVE TODAY
Your file never leaves your phone. Seal takes its fingerprint on your device, and your wallet signs only that
fingerprint. Signing and checking are free. Need more signers? Send the link: each person opens it, signs and passes
it on; the seal travels in the link itself, not through a server. Anchor on Base for about two cents in ETH plus
network gas: one transaction carries as many seals as you add, and each gets its own proof that it existed by that
block. Change one byte of the file and Verify fails. Connect a wallet app through WalletConnect, or open Taproot inside
your wallet's own browser.

What a seal proves: which wallets signed which exact file. It does not prove who owns a wallet in real life, and it
does not make an agreement legally binding. Anchoring is in beta and needs a regular wallet; smart wallets can sign
seals but cannot anchor them yet.

PAYMENTS CONSOLE
Taproot also carries a non-custodial payments console for merchants on Base: USDC settles straight to your own
contract and wallet, with no company in the middle that can hold a balance, reverse a sale or close an account.
Launching a new payments contract from the app is paused until the contract's external review is complete.

WHAT TAPROOT DOES NOT DO
It never holds your keys or your funds. There is no account and no sign-up. It does not trade, lend or exchange
anything.

OPEN SOURCE
MIT, at github.com/jonb89201-svg/Taproot-App. Built on Base.

**Release notes:** `Seal documents with your wallet, check seals, and anchor them on Base. Phones can connect a wallet
app through WalletConnect.`

**Privacy policy URL:** `https://taproot.possessio.io/privacy`
**Category:** Productivity, decided 2026-10-20: Seal leads the listing, and Finance invites Play's financial-services questions about a feature that is paused. **Contact email:** yours. **Target audience:** 18 and over.
**Graphics:** `assets_base/icon_512.png`, `assets_base/feature_1024x500.png`, screenshots `shot5` to `shot8` (Seal)
first, then `shot1` to `shot4` (console), all 1284×2283.

## The forms, answers that match the code
- App access: everything works without a login. Ads: none. Content rating: no violence, no user-to-user chat, no
  gambling; it shows wallet addresses and blockchain transactions. Target audience: 18 and over.
- Data safety: the page collects nothing and has no accounts. WalletConnect, only when the user picks it: the wallet
  address (User IDs), usage events (App interactions) and the WalletConnect client identifier (Device IDs), shared
  with Reown, optional, encrypted in transit. Cloudflare Web Analytics on every page view: App interactions and
  Diagnostics, collected not shared, required. Files: never collected, hashed on the device. `PLAY_STORE.md` Step 6
  has the long form.
- Financial features: Seal is not a financial service; the console is non-custodial, holds no funds and exchanges
  nothing. If the form asks for a licence, stop and ask.

## What the listing must not say
- That the contract is audited. The external review is scoped, not delivered.
- Anything about the trading desk, which is gone.
- Anything about a token.
