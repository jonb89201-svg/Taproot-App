# Contract ABIs

`PossessioPayments.abi.json` is generated from the **fixed** contract in the Possessio repo, not copied by hand:

```
cd Possessio && forge inspect src/PossessioPayments.sol:PossessioPayments abi --json
```

Generated 2026-10-14 from `src/PossessioPayments.sol` at Possessio `main@16fa42b`. The last contract change is f0e545e (re-audit 2026-09-01).

`node test/abi-sync.mjs` checks the console's Payments panel against this ABI. It fails if any panel entry calls a function the fixed contract doesn't have, or if the contract has a callable function the panel leaves out. Regenerate this file whenever `PossessioPayments.sol` changes.
