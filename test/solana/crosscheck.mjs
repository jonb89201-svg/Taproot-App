// Cross-check of Seal's hand-built Solana anchor against Solana's own library.
//   cd test/solana && npm ci && node crosscheck.mjs
// seal-core.mjs writes the anchor transaction byte by byte, so the page needs no Solana library. This builds the
// same transfer + memo with @solana/web3.js and requires the two to be identical, byte for byte; then it signs the
// message with a throwaway keypair and has web3.js read the signed transaction back. Offline: no RPC is called.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
// The Farcaster wire, the exact version @farcaster/miniapp-sdk 0.3.0 (the one seal.html loads) pins.
import { unwrapSolanaProviderRequest, wrapSolanaProviderRequest } from "@farcaster/miniapp-core/dist/solanaWire.js";
const S = await import(new URL("../../seal-core.mjs", import.meta.url));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const payer = Keypair.generate();
const fee = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();   // any 32 bytes in base58 serve as a blockhash here
const root = "0x" + "5e".repeat(32);

for (const lamports of [1n, 133334n, 2n ** 40n + 7n]) {
  const ours = S.solanaAnchorMessage({ payer: payer.publicKey.toBase58(), feeAddress: fee.toBase58(), lamports, recentBlockhash: blockhash, root });
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: fee, lamports }));
  tx.add(new TransactionInstruction({ programId: new PublicKey(S.SOLANA_MEMO_PROGRAM), keys: [], data: Buffer.from(S.solanaMemo(root), "utf8") }));
  const theirs = tx.serializeMessage();
  ok(eq([...ours], [...theirs]), `the message for ${lamports} lamports matches web3.js byte for byte (${ours.length} bytes)`);
  tx.sign(payer);
  const unsigned = S.solanaAnchorTransaction({ payer: payer.publicKey.toBase58(), feeAddress: fee.toBase58(), lamports, recentBlockhash: blockhash, root });
  const signed = Uint8Array.from(unsigned); signed.set(tx.signature, 1);
  const back = Transaction.from(Buffer.from(signed));
  ok(back.verifySignatures() && eq([...back.serialize()], [...signed]), "filling the signature slot gives a transaction web3.js reads back and verifies");
}
ok(new PublicKey(S.SOLANA_SYSTEM_PROGRAM).equals(SystemProgram.programId), "the System Program id is web3.js's");
for (let k = 0; k < 50; k++) {
  const b = Keypair.generate().publicKey;
  if (S.base58Encode(b.toBytes()) !== b.toBase58() || !eq([...S.base58Decode(b.toBase58())], [...b.toBytes()])) { ok(false, "base58 differs for " + b.toBase58()); break; }
  if (k === 49) ok(true, "base58 matches web3.js for 50 random keys");
}

// Through the Farcaster mini app's wire: the SDK side (unwrap) serializes what Seal hands it; the host side (wrap)
// rebuilds a web3.js transaction from that and passes it to the wallet. The wallet must receive Seal's message.
{
  const lamports = 133334n;
  const args = { payer: payer.publicKey.toBase58(), feeAddress: fee.toBase58(), lamports, recentBlockhash: blockhash, root };
  const unsigned = S.solanaAnchorTransaction(args);
  let atWallet = null;
  const wallet = async (req) => { atWallet = req.params.transaction; return { signature: "5".repeat(88) }; };
  const host = wrapSolanaProviderRequest(wallet);
  const sdkSide = unwrapSolanaProviderRequest(host);
  const provider = { signAndSendTransaction: (input) => sdkSide({ method: "signAndSendTransaction", params: input }) };
  const sig = await S.sendSolanaAnchor(provider, unsigned);
  const msg = atWallet instanceof VersionedTransaction ? atWallet.message.serialize() : atWallet.serializeMessage();
  ok(sig === "5".repeat(88), "the signature the wallet returns comes back through the wire");
  ok(eq([...msg], [...S.solanaAnchorMessage(args)]), "the wallet behind the Farcaster wire receives Seal's message, byte for byte");
  const keys = atWallet.message.staticAccountKeys.map((k) => k.toBase58());
  ok(keys[0] === payer.publicKey.toBase58() && keys[1] === fee.toBase58(), "the host reads the payer and the fee wallet where Seal put them");
}
console.log(`RESULT: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
