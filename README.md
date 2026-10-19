# Taproot

**Non-custodial USDC payments. You own the money — nobody can freeze it, reverse it, or cut you off.**

Taproot is an open-source merchant console for accepting **USDC on Base**. It's software you
run, not a payment processor. Funds settle straight to your own wallet — there's no company in
the middle that can hold your balance, claw back a sale, or close your account.

- **You hold the funds** — payments go directly to your wallet. Non-custodial by design.
- **No chargebacks** — on-chain payments are final. No reversals weeks later.
- **No deplatforming** — open-source software, not a service with terms that can ban you.
- **Built on Base** — powered by the `PossessioPayments` contract; low fees, fast settlement.

For any merchant who'd rather own their payments than rent them.

## Run it
Single static page. The live copy is served at `taproot.possessio.io` (Cloudflare in front, MEASURED
2026-10-19); any static host works (GitHub Pages: Settings → Pages → deploy from `main`, root;
`.nojekyll` keeps `.well-known/` served). Open `index.html` in a wallet browser to try it.

## Install it
- **Home screen.** The page is an installable web app: `manifest.webmanifest`, icons in `assets_base/`,
  and `sw.js`, a service worker that stays out of the way (network first on this origin, the last good
  copy offline; nothing cross-origin is touched). Chrome offers *Install app*; iOS uses *Add to Home Screen*.
- **Farcaster / Base App mini app.** `/.well-known/farcaster.json` describes the app (icon, splash,
  screenshots, category, `requiredChains` Base) and the `fc:miniapp` meta tag on the console makes a
  shared link open it. The signed `accountAssociation` is added by the Architect from Farcaster's
  manifest tool; the file carries everything else.
- **Google Play.** A Trusted Web Activity wraps the same site. The whole path, with what is done and
  what waits on Play's certificate fingerprints, is in [`docs/PLAY_STORE.md`](docs/PLAY_STORE.md).
  `android/twa-manifest.json` is the Bubblewrap project (no secrets in it).
- `node test/console.smoke.mjs` measures all of it: the manifest, the worker's registration, the
  Farcaster manifest's limits and that every image they point at exists.

**The trading desk is gone (2026-10-19).** The in-console AI trading desk prototype, its Funding Vault,
Auto-Target and Trader Rail panels, the vault launch type, the Solana leg and the desk error sink were
removed from the console. Taproot is a payments console. `node test/console.smoke.mjs` goes red if any
of it comes back.

## Powered by
[POSSESSIO](https://github.com/jonb89201-svg/Possessio) — `PossessioPayments`.

**Contract status (2026-10-19).**
- **The console drives PossessioPayments v3.0.2, the auction sweep.** Incoming USDC above a float is swept
  on the merchant's schedule: one share deposited to a Morpho USDC vault, the other sold for cbETH in an
  oracle-floored Dutch auction (`kick` / `take`, floor 99% of Chainlink). Money leaves only to payees set 48
  hours in advance, within per-asset daily limits, or through a 7-day emergency path. There is no guardian
  role. The Payments panel covers every write of the contract and the reads that matter, with plain-language
  labels; the treasury card reads USDC, cbETH and the Morpho position, and checks `isPayee` before a send.
- **Review.** The contract was audited and re-audited by POSSESSIO's AI council seats; an external review by
  KupiaSec is in progress (2026-10-19). The findings so far are fixed in source (Possessio
  `src/PossessioPayments.sol`), with regression tests.
- **Not deployed yet.** v3.0.2 waits on the external review and the redeploy. The instance live on Base
  mainnet at `0x67247eB2108E7229331127DF1309D624d95467ca` is the pre-fix build; read it as the pre-audit
  deployment.
- **Launch rail: ready, in preview.** The rail builds v3's `DeployParams` (the eight Base addresses the
  template pins at deploy, the float, the smallest sweep, the two daily limits, the owner as first payee) and
  hashes `artifacts/payments.json` against the factory's `templateCodehash` on chain before any signature.
  The live factory `0x0DD06656…49Bd` pins the pre-fix template, so the rail stays in preview until a factory
  pinning v3.0.2 is deployed and its address is set.

**How the console stays in sync.** `node tools/sync-from-possessio.mjs <Possessio checkout>` regenerates
`abi/PossessioPayments.abi.json`, `abi/PossessioPayments.wiring.json` (the Base wiring and the `DeployParams`
fields, read from the source) and `artifacts/payments.json` (the template's creationCode and its keccak256)
from a forge build. `node test/abi-sync.mjs` fails if the panel, the rail's wiring or tuple, the artifact or the
treasury card's fragments drift from them, and if the rail points at the pre-fix factory.

## Seal 🦭 (beta)

[`seal.html`](seal.html) seals a document with your wallet.

- **On your device.** The file is hashed (SHA-256) in the browser and never uploaded.
- **Signing.** Each signer signs the same EIP-712 message: the document hash, a title and the time. Signing
  works with plain wallets and smart wallets (ERC-1271, and ERC-6492 for wallets not deployed yet). The seal
  travels as a JSON file or in a link's fragment, never through a server.
- **Short links.** A link (`#s=`) carries the seal's fields as bytes: about 236 characters for a one-signature seal,
  against about 590 for the old JSON link (`#seal=`), which still opens. Shorter titles make shorter links.
  - A plain-wallet signer is recovered from its signature, so the link carries only the first 4 bytes of its address,
    as a check. A link with one changed character is refused as damaged. Without the check, most such changes opened
    under a stranger's address and still verified (MEASURED 2026-10-15: 284 of 438 one-byte changes).
  - A smart-wallet signer is carried whole.
  - Short links made before the check (version 2, 2026-10-15) still open.
- **Free.** Signing and verifying cost nothing.
- **Anchoring.** One Base transaction posts a Merkle root of any number of signed seals. That proves the seals,
  with their signatures, existed by that block. The transaction pays **$0.02 in ETH**, priced live from
  Chainlink ETH/USD and rounded up, plus network gas. Calldata is `"SEAL"` + `0x01` + root + the Taproot
  Builder Code suffix.
- **Verifying an anchored seal** (since 2026-10-19, after KupiaSec's review of the Seal). The verifier judges the
  seal at its anchor, not at today's state:
  - The anchor transaction must have gone to the Seal fee wallet, carry the batch's root, and pay the fee its
    block owed: $0.02 at the ETH/USD price in force at that block, read from the feed at that block. An anchor
    that paid less than 95% of it (`FEE_TOLERANCE_BPS`, room for the price to move between the quote and the
    block) fails the `anchor fee` check. Before this, the verifier read only the calldata and the root, so the
    fee was optional.
  - Every signature is checked against the chain's state **at the anchor's block**. A smart wallet's owners can
    change after a seal is anchored, or before: what counts is who owned the wallet when the anchor landed.
    Before this, smart-wallet signatures were checked against today's state.
  - Both need an RPC that holds state at the anchor's block. The public Base and Base Sepolia endpoints do
    (MEASURED 2026-10-19: `eth_call` served 20,000,000 blocks behind the head on both). An RPC that doesn't
    says so in the check instead of blaming the signature, and the seal is not claimed.
  - A seal without an anchor has no such moment; its signatures are checked at the latest block, as before.
- **Where the fee goes.**
  - The fee goes to the Seal fee wallet `0x9Ce4cb26A5F7B50826B07eb8B2C065F0Bb37a6c9`, a plain wallet, on Base and
    on Base Sepolia.
  - The Architect sweeps it into the STEEL Treasury Safe `0x19495180FFA00B8311c85DCF76A89CCbFB174EA0` (Safe 1.4.1,
    2-of-4).
  - The Safe can't be the fee address itself: an anchor is ETH plus data, and the Safe reverts on that, while a plain
    transfer into it succeeds (MEASURED 2026-10-15 on a fork of Base mainnet).
  - So the page refuses any fee address that has contract code.
- **Who can anchor: a regular wallet.**
  - Smart wallets (a Base Account, for one) can sign seals, but the page won't send an anchor from one. A smart
    wallet wraps the call in its own `execute()`: the fee still moves, but the transaction no longer starts with the
    anchor, so the seal can't be verified, and the Builder Code sits under padding, so Base doesn't count it
    (MEASURED 2026-10-15 on a Base mainnet fork with a Coinbase Smart Wallet).
  - The page refuses a sender with contract code, or one whose wallet reports through EIP-5792 that it runs as a smart
    account. That report is what catches a Base Account that isn't deployed yet.
  - An EIP-7702 account still sends its own transactions, and its anchors verify, so its delegation marker alone
    doesn't refuse it.
- **Networks.** Base mainnet is the default. Base Sepolia moves test ETH only.

**Tests.** `npm install`, then:

| Command | What it runs |
|---|---|
| `npm test` | ABI sync (panel, rail wiring and tuple, artifact, treasury fragments), plus the Seal suite (needs Foundry's `anvil`): offline checks; a Base Sepolia fork with a real anchor transaction and ERC-1271/6492 signatures; and a Base mainnet fork that anchors to the real fee wallet, and shows why neither the Treasury Safe (as the fee address) nor a smart wallet (as the sender) works |
| `node test/seal-mutants.mjs` | Planted breaks: every one must turn the suite red |
| `node test/seal.e2e.mjs` | The page itself in headless Chromium (needs Playwright) |
| `node test/console.smoke.mjs` | The console (`index.html`) in headless Chromium: loads clean, and nothing of the trading desk is left (needs Playwright) |

## License
MIT — see [LICENSE](LICENSE).
