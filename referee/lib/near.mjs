// Minimal NEAR access for the referee: reads via RPC, writes signed with the local legacy keychain key.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "dotenv/config";
import { Near } from "near-kit";

export const cfg = {
  network: process.env.NEAR_NETWORK || "testnet",
  contract: process.env.PACT_CONTRACT || "pact-arena.testnet",
  referee: process.env.PACT_REFEREE || "pact-arena.testnet",
  model: process.env.PACT_MODEL || "z-ai/glm-5.3-flash",
  apiKey: process.env.NEARAI_API_KEY,
  rpc: process.env.NEAR_RPC || "https://rpc.testnet.near.org",
};

function keyFor(account) {
  const f = join(homedir(), ".near-credentials", cfg.network, `${account}.json`);
  if (!existsSync(f)) throw new Error(`no key for ${account} at ${f}`);
  return JSON.parse(readFileSync(f, "utf8")).private_key;
}

let _near;
export function near() {
  if (!_near) _near = new Near({ network: cfg.network, privateKey: keyFor(cfg.referee), defaultSignerId: cfg.referee });
  return _near;
}

export async function nearView(method, args = {}) {
  return near().view(cfg.contract, method, args);
}

/** Sends a function call and returns the method's decoded return value (near-kit returns the raw outcome). */
export async function nearCall(contract, method, args = {}, opts = {}) {
  const res = await near().call(contract, method, args, { gas: opts.gas || "300 Tgas", attachedDeposit: opts.deposit || "0 NEAR", signerId: cfg.referee });
  const sv = res?.status?.SuccessValue;
  if (sv === undefined) throw new Error(`${method} failed: ${JSON.stringify(res?.status).slice(0, 300)}`);
  if (!sv) return null;
  const txt = Buffer.from(sv, "base64").toString("utf8");
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}
