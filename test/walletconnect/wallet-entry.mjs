// A throwaway WalletConnect wallet for test/walletconnect/e2e.mjs. It runs in its own browser profile, pairs over the
// live relay, approves Base, answers eth_signTypedData_v4 with a fresh key that never leaves the page, and broadcasts
// eth_sendTransaction to the RPC it was given (an anvil fork in the test). Modes:
//   "wrong-key"   signs with a second key, so the Seal page must refuse the signature;
//   "misroute"    sends the anchor's ETH to itself instead of the page's recipient and returns that hash, so the
//                 page's re-verification must fail instead of trusting the wallet.
import { Core } from "@walletconnect/core";
import { WalletKit } from "@reown/walletkit";
import { buildApprovedNamespaces } from "@walletconnect/utils";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// eth_signTypedData_v4 carries JSON: integers arrive as strings and EIP712Domain is spelled out.
function typedData(json) {
  const td = JSON.parse(json);
  const types = { ...td.types };
  delete types.EIP712Domain;
  const message = { ...td.message };
  for (const f of types[td.primaryType] || []) if (/^u?int\d*$/.test(f.type) && message[f.name] != null) message[f.name] = BigInt(message[f.name]);
  const domain = { ...td.domain };
  if (domain.chainId != null) domain.chainId = Number(domain.chainId);
  return { domain, types, primaryType: td.primaryType, message };
}

window.walletStart = async ({ projectId, mode, rpc }) => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = mode === "wrong-key" ? privateKeyToAccount(generatePrivateKey()) : account;
  const log = (window.walletLog = []);
  const chain = rpc ? createWalletClient({ account, chain: base, transport: http(rpc) }) : null;
  const kit = await WalletKit.init({
    core: new Core({ projectId }),
    metadata: { name: "Seal e2e wallet", description: "throwaway test wallet", url: location.origin, icons: [] },
  });
  kit.on("session_proposal", async ({ id, params }) => {
    const namespaces = buildApprovedNamespaces({
      proposal: params,
      supportedNamespaces: {
        eip155: {
          chains: ["eip155:8453", "eip155:84532"],
          methods: ["eth_accounts", "eth_requestAccounts", "eth_chainId", "eth_signTypedData_v4", "personal_sign", "eth_sendTransaction", "wallet_switchEthereumChain"],
          events: ["accountsChanged", "chainChanged"],
          accounts: ["eip155:8453:" + account.address, "eip155:84532:" + account.address],
        },
      },
    });
    window.walletProposal = { required: params.requiredNamespaces, optional: params.optionalNamespaces };
    await kit.approveSession({ id, namespaces });
    log.push("approved " + (namespaces.eip155 ? namespaces.eip155.chains.join(",") : "nothing"));
  });
  kit.on("session_request", async ({ topic, id, params }) => {
    const { method, params: p } = params.request;
    log.push(method);
    let response;
    try {
      if (method === "eth_signTypedData_v4") {
        response = { id, jsonrpc: "2.0", result: await signer.signTypedData(typedData(p[1])) };
      } else if (method === "eth_sendTransaction" && chain) {
        const tx = p[0];
        const to = mode === "misroute" ? account.address : tx.to;
        const hash = await chain.sendTransaction({ to, value: tx.value ? BigInt(tx.value) : 0n, data: tx.data || "0x" });
        window.walletSent = { hash, to, requestedTo: tx.to };
        response = { id, jsonrpc: "2.0", result: hash };
      } else {
        response = { id, jsonrpc: "2.0", error: { code: 4200, message: "the e2e wallet only signs typed data" + (chain ? " and sends transactions" : "") } };
      }
    } catch (e) {
      response = { id, jsonrpc: "2.0", error: { code: -32000, message: "e2e wallet: " + (e.shortMessage || e.message) } };
    }
    await kit.respondSessionRequest({ topic, response });
  });
  window.walletPair = (uri) => kit.pair({ uri });
  return account.address;
};
window.walletReady = true;
