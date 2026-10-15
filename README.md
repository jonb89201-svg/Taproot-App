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
Single static page. Host on **GitHub Pages** (Settings → Pages → deploy from `main`, root),
or any static host. Open `index.html` in a wallet browser to try it.

## Powered by
[POSSESSIO](https://github.com/jonb89201-svg/Possessio) — `PossessioPayments`.

**Contract status (2026-10-14).**
- **Audits.** The contract was audited and re-audited by POSSESSIO's AI council seats, not by a third-party
  firm. The findings are fixed in source (Possessio `src/PossessioPayments.sol`), with regression tests.
- **Fixed contract: not deployed yet.** It is pending redeploy.
- **Pre-fix instance.** The instance live on Base mainnet at `0x67247eB2108E7229331127DF1309D624d95467ca`
  predates those fixes. Read it as the pre-audit deployment.
- **Launch rail: off.** The live factory `0x0DD06656…49Bd` pins the pre-fix template
  (`templateCodehash` `0x14357940…e39d`). The rail stays in preview until a factory pinning the fixed
  template is deployed.

**How the console stays in sync.** The console's Payments panel follows the fixed contract.
`abi/PossessioPayments.abi.json` is generated from that source. `node test/abi-sync.mjs` fails if the
panel and the contract drift apart, and if the rail points at the pre-fix factory.

## Seal 🦭 (beta)

[`seal.html`](seal.html) seals a document with your wallet.

- **On your device.** The file is hashed (SHA-256) in the browser and never uploaded.
- **Signing.** Each signer signs the same EIP-712 message: the document hash, a title and the time. Signing
  works with plain wallets and smart wallets (ERC-1271, and ERC-6492 for wallets not deployed yet). The seal
  travels as a JSON file or in a link's fragment, never through a server.
- **Free.** Signing and verifying cost nothing.
- **Anchoring.** One Base transaction posts a Merkle root of any number of signed seals. That proves the seals,
  with their signatures, existed by that block. The transaction pays **$0.02 in ETH**, priced live from
  Chainlink ETH/USD and rounded up, plus network gas. Calldata is `"SEAL"` + `0x01` + root + the Taproot
  Builder Code suffix.
- **Where the fee goes.**
  - The fee goes to the Seal fee wallet `0x9Ce4cb26A5F7B50826B07eb8B2C065F0Bb37a6c9`, a plain wallet, on Base and
    on Base Sepolia.
  - The Architect sweeps it into the STEEL Treasury Safe `0x19495180FFA00B8311c85DCF76A89CCbFB174EA0` (Safe 1.4.1,
    2-of-4).
  - The Safe can't be the fee address itself: an anchor is ETH plus data, and the Safe reverts on that, while a plain
    transfer into it succeeds (MEASURED 2026-10-15 on a fork of Base mainnet).
  - So the page refuses any fee address that has contract code.
- **Networks.** Base mainnet is the default. Base Sepolia moves test ETH only.

**Tests.** `npm install`, then:

| Command | What it runs |
|---|---|
| `npm test` | ABI sync, plus the Seal suite (needs Foundry's `anvil`): offline checks; a Base Sepolia fork with a real anchor transaction and ERC-1271/6492 signatures; and a Base mainnet fork that anchors to the real fee wallet, and shows why the Treasury Safe can't be paid directly |
| `node test/seal-mutants.mjs` | Planted breaks: every one must turn the suite red |
| `node test/seal.e2e.mjs` | The page itself in headless Chromium (needs Playwright) |

## License
MIT — see [LICENSE](LICENSE).
