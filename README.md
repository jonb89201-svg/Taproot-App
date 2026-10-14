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

## License
MIT — see [LICENSE](LICENSE).
