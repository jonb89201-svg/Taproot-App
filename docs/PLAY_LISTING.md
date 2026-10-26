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
**Full description** (4,000 max, this is about 1,900):

Taproot is two tools in one page: Seal, which seals documents with your wallet, and a non-custodial payments console
for merchants on Base.

SEAL, LIVE TODAY
Seal hashes a document in your browser, lets the people involved sign that hash with their wallets, and anchors it to
Base for about two cents. The document itself never leaves your device. Anyone can later check that a file is the one
that was sealed, and see the moment a file was changed. Use it for a bill of sale, a lease, a quote, a receipt: anything
two people want to be able to prove later.

PAYMENTS CONSOLE
Accept USDC straight to your own wallet. Taproot is software you run, not a payment processor: no company in the
middle can hold your balance, reverse a sale or close your account. Payments settle to your wallet and are final. The
console drives the open-source PossessioPayments contract: incoming USDC above a float is swept on your own schedule,
part to a Morpho USDC vault and part sold for cbETH in an oracle-floored auction, and money leaves only to payees set
48 hours in advance, within daily limits. Launching a new payments contract from the app is paused until the
contract's external review is complete; the console reads and drives contracts that already exist.

WHAT TAPROOT DOES NOT DO
It never holds your keys or your funds. There is no account and no sign-up. It does not trade, lend or exchange
anything.

HOW IT WORKS
The app opens taproot.possessio.io full screen. It needs a wallet: a wallet app's browser, a browser wallet, or
WalletConnect. Transactions go from your wallet to Base; Taproot only prepares them for you to sign.

OPEN SOURCE
The code is public at github.com/jonb89201-svg/Taproot-App. Built on Base.

**Privacy policy URL:** `https://taproot.possessio.io/privacy`
**Category:** Finance. **Contact email:** yours. **Target audience:** 18 and over.
**Graphics:** `assets_base/icon_512.png`, `assets_base/feature_1024x500.png`, screenshots `shot5` to `shot8` (Seal)
first, then `shot1` to `shot4` (console), all 1284×2283.

## What the listing must not say
- That the contract is audited. The external review is scoped, not delivered.
- Anything about the trading desk, which is gone.
- Anything about a token.
