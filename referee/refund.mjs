// Anyone can refund a match whose referee went silent. Signs as any account in the local keychain.
// Usage: node refund.mjs <signer.testnet> <matchId> [...]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";
import { cfg } from "./lib/near.mjs";
const [signer, ...ids] = process.argv.slice(2);
const key = JSON.parse(readFileSync(join(homedir(), ".near-credentials", cfg.network, `${signer}.json`), "utf8")).private_key;
const near = new Near({ network: cfg.network, privateKey: key, defaultSignerId: signer });
for (const id of ids.map(Number)) {
  try {
    const res = await near.call(cfg.contract, "refund_stale", { id }, { gas: "30 Tgas" });
    const m = JSON.parse(Buffer.from(res.status.SuccessValue, "base64").toString());
    console.log(`refund_stale(${id}) signed by ${signer}: ${m.status}, ${m.a} and ${m.b} got their stakes back`);
  } catch (e) {
    console.log(`refund_stale(${id}): ${String(e.panic || e.message).replace("Smart contract panicked: ", "")}`);
  }
}
