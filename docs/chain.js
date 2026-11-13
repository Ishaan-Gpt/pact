// Read-only access to the Pact contract straight from a NEAR RPC node (no server needed).
export const CONTRACT = "game.pact-arena.testnet";
const RPC = "https://rpc.testnet.near.org";

export async function view(method, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(j.result?.error || j.error?.cause?.name || "RPC error");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}
