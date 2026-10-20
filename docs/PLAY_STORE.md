# Taproot on the Google Play Store

How Taproot gets from a web page to a Play Store listing, and which parts are already done.
The Architect is a verified Play developer (2026-10-19); the steps marked **you** are done from
the Play Console and a browser. Nothing here needs a terminal.

## What this repo already provides (MEASURED by `node test/console.smoke.mjs`)

| Piece | Where | Why Play needs it |
|---|---|---|
| Web app manifest | `/manifest.webmanifest` | The Android wrapper reads the name, colors, icons and start URL from it; Chrome offers "Install app" from it |
| Service worker | `/sw.js` | A home-screen install needs one with a fetch handler. Ours is network-first and touches nothing cross-origin |
| Icons | `assets_base/icon_192.png`, `icon_512.png`, `icon_512_maskable.png`, `icon_180.png` | Launcher icons, including the maskable one Android crops |
| Listing art | `assets_base/icon_512.png`, `feature_1024x500.png`, `shot*_9x16.png` | Play's icon, feature graphic and phone screenshots |
| Wrapper project | `android/twa-manifest.json` | For a local Bubblewrap build; the PWABuilder route below needs none of it |
| Privacy page | `/privacy.html` | Play requires a privacy policy URL for every app. **Draft: read it before you paste the URL** |

## Why a wrapper, and which one

Play distributes Android packages. For a web app the standard is a **Trusted Web Activity**: a
thin Android app that opens `https://taproot.possessio.io` full-screen in Chrome. The site keeps
updating itself; the app never needs a rebuild for a page change. Two things bind them: the web
manifest (above) and **Digital Asset Links**, a file on the site that names the app's signing
certificate. Until that file is live, the wrapper still works but shows Chrome's address bar.

## Step 1 (after this PR merges) — check the site passes the install checks

- `https://taproot.possessio.io/manifest.webmanifest` must come back as JSON. (Before this PR the
  host answered that path with the console's HTML, MEASURED 2026-10-19: the file did not exist.)
- `https://taproot.possessio.io/sw.js` must come back as JavaScript.
- Chrome on Android → menu → **Install app** is offered.
- Optional score: https://www.pwabuilder.com → enter the URL.

## Step 2 (you) — build the Android package with PWABuilder

1. https://www.pwabuilder.com → enter `https://taproot.possessio.io` → **Package for stores** → **Android**.
2. Settings: Package ID `io.taproot.possessio` · App name `Taproot` · Launcher name `Taproot` ·
   App version `1.0.0`, version code `1` · Host `taproot.possessio.io` · Start URL `/` ·
   Display `standalone` · Theme and background color `#ffffff` · Icon `/assets_base/icon_512.png` ·
   Maskable icon `/assets_base/icon_512_maskable.png` · Signing key: **Create new** (PWABuilder
   generates the upload keystore for you).
3. Download the zip. It holds:
   - `app-release-bundle.aab` — what you upload to Play.
   - `app-release-signed.apk` — for sideloading onto your own phone to try it.
   - `signing.keystore` and `signing-key-info.txt` — **secrets**. Keep them where you keep the
     RRC key material. Every future update must be signed with this key. Never in git, never in chat.
   - `assetlinks.json` — carries the **upload** key's SHA-256. Step 4 needs it, plus one more value.

Measured on the first upload (2026-10-20, reported by the Architect from the Play Console and PWABuilder):

- **The Play Console holds the package name to `io.taproot.possessio`.** A bundle with any other name
  is refused at upload ("package name must be io.taproot.possessio"). The name cannot be changed
  afterwards, so every rebuild uses it.
- **PWABuilder starts each build from its defaults, not from the last one:** Package ID
  `io.possessio.taproot.twa`, Start URL `/`, version `1.0.0.0`, signing key *None*. Re-enter the
  settings above every time. A default build was refused twice that night: unsigned first, then for
  the package name.
- **A signed build takes 30 to 40 seconds to download; an unsigned one arrives within seconds.** A
  zip that comes back at once was built without a key.

Alternative for a computer with JDK 17 and the Android SDK: `npm i -g @bubblewrap/cli`, then
`cd android && bubblewrap build` using the committed `twa-manifest.json`.

## Step 3 (you) — Play Console

1. https://play.google.com/console → **Create app**: name `Taproot`, App, Free, accept the declarations.
2. **Testing → Internal testing → Create release** → upload `app-release-bundle.aab`. Play App
   Signing is on by default: Google holds the app signing key, your keystore is the upload key.
3. **Setup → App integrity → App signing key certificate**: copy the **SHA-256 certificate
   fingerprint**. Copy the **Upload key certificate** SHA-256 as well.
4. Send me both fingerprints. They are public values (certificate hashes), safe to paste.
5. **Before production: closed testing.** Reported for personal developer accounts created after
   2023-11-13: production stays locked until a closed test has run with at least 12 opted-in testers
   for 14 days in a row (organization accounts, which need a D-U-N-S number, are reported exempt).
   Read from third-party guides on 2026-10-20, not from Google's own page: check what your Play
   Console shows. If it applies, start the closed test as early as possible; the 14 days are the
   longest step here.

## Step 4 (me) — Digital Asset Links

With the two fingerprints I add `/.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": { "namespace": "android_app", "package_name": "io.taproot.possessio",
              "sha256_cert_fingerprints": ["<Play app signing SHA-256>", "<upload key SHA-256>"] }
}]
```

It is not in this PR because the fingerprints do not exist yet, and an invented one would be a
lie the wrapper acts on. Check after it lands:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://taproot.possessio.io&relation=delegate_permission/common.handle_all_urls`

## Step 5 (you) — the store listing

- App icon: `assets_base/icon_512.png` (512×512 PNG, 227 KB; Play's limit is 1 MB).
- Feature graphic: `assets_base/feature_1024x500.png`.
- Phone screenshots (2 to 8), all 1284×2283 (9:16):
  - Seal, live today: `assets_base/shot5_seal_choose_9x16.png`, `shot6_seal_signed_9x16.png`,
    `shot7_seal_verified_9x16.png`, `shot8_seal_changed_9x16.png`. A real seal of a sample bill of sale,
    signed by two throwaway wallets; `shot8` is Verify after "$250" became "$950" in the file.
  - Payments console: `shot1_hero_9x16.png` … `shot4_slider_9x16.png`.
  - Lead with Seal. Launching a payments contract is paused until the contracts are audited, and a
    reviewer tests what the listing promises.
- Short description (80 chars max): `Seal documents with your wallet. Proof on Base for $0.02.` (57).
  The old one, `Non-custodial USDC payments on Base. You own the money.`, describes the paused part.
- Full description: start from the README's first section.
- Privacy policy URL: `https://taproot.possessio.io/privacy.html` — read the draft first.
- Category: Finance. Contact email: yours.

## Step 6 (you) — the forms Play asks every app

- **Content rating** questionnaire.
- **Data safety**: the page itself collects nothing and has no accounts. Wallet connections happen
  in the user's wallet. Third parties the page talks to: Base RPC endpoints (reads), the Chainlink
  ETH/USD feed (reads), CDNs for `ethers`, `viem` and fonts, Cloudflare for hosting. Answer from
  what the code does.
  - **WalletConnect** (since 2026-10-20) is the one third party that collects something: when a user
    with no wallet in the browser chooses it, Reown's relay sees the IP address, and the WalletConnect
    window sends Reown usage events (`pulse.walletconnect.org`). The provider version in use gives
    no switch to turn those off. Declare it (app activity / app interactions, shared with Reown,
    optional: only when the user chooses WalletConnect). `privacy.html` says the same.
- **Financial features**: Play asks whether the app is a crypto exchange or wallet, or offers loans.
  Taproot is a non-custodial merchant console: it holds no funds and exchanges nothing; Seal anchors
  pay a $0.02 fee in ETH. Answer truthfully. If the form asks for a license, stop and tell me: that
  is your decision, not a form field.
- **Target audience**: 18 and over.

## Not in this PR, on purpose

- `.well-known/assetlinks.json` — waits on the fingerprints (Step 3).
- The `.aab` — not in git. PWABuilder builds it from the live site and the settings above; the first
  one was accepted by the Play Console on 2026-10-20 (reported by the Architect).
- The Farcaster `accountAssociation` — https://farcaster.xyz/~/developers/mini-apps/manifest signs
  the domain with your Farcaster custody key (desktop page, phone confirms); paste the result into
  `.well-known/farcaster.json` next to `miniapp`.
