// Audit any settled match from public data only: the on-chain record plus runs/match-<id>.json.
// Proves: each move was signed by the attested enclave key, over exactly the published request
// and response bytes; the request carried the agent's own sealed strategy (unreadable here) and the
// published public messages; the decrypted answer says the move the contract paid out on.
// Usage: node verify.mjs <matchId> [path/to/match.json]
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { nearView } from "./lib/near.mjs";
import { seal, open, sha256Hex, hexToBytes } from "./lib/e2ee.mjs";
import { parseDecision } from "./lib/game.mjs";

export async function verifyMatch(id, file = `runs/match-${id}.json`) {
  const onchain = await nearView("get_match", { id: Number(id) });
  const info = await nearView("info");
  const run = JSON.parse(readFileSync(file, "utf8"));
  const rows = [];
  const check = (name, ok, note = "") => rows.push({ name, ok: !!ok, note });

  check("match is settled on chain", onchain?.status === "Settled", onchain?.status);
  check("transcript on chain = published transcript", JSON.stringify(onchain.transcript) === JSON.stringify(run.transcript));
  check("transcript hash", sha256Hex(run.transcript.join("\n")) === run.transcript_hash);
  check("signing key is registered on chain", info[3].includes(run.model_key), run.model_key.slice(0, 16) + "...");

  for (const d of onchain.decisions) {
    const call = run.calls.filter((c) => c.agent === d.agent_id && c.kind === "decide" && c.signature.text === d.text)[0];
    const who = d.agent_id;
    check(`${who}: published request found for the signed decision`, call);
    if (!call) continue;
    const [model, reqHash, respHash] = [d.text.split(":").slice(0, -2).join(":"), ...d.text.split(":").slice(-2)];
    check(`${who}: enclave signature verifies (ed25519)`, ed25519.verify(hexToBytes(d.signature), new TextEncoder().encode(d.text), hexToBytes(d.tee_key)));
    check(`${who}: signed by the model enclave, not the gateway`, model === run.model);
    check(`${who}: sha256(request bytes) = signed request hash`, sha256Hex(call.request_body) === reqHash);
    check(`${who}: sha256(response bytes) = signed response hash`, sha256Hex(call.response_body) === respHash);
    const req = JSON.parse(call.request_body);
    const strat = req.messages[call.sealed_strategy_index].content;
    check(`${who}: request carried the agent's sealed strategy`, sha256Hex(strat) === d.strategy_hash, "sealed, unreadable here");
    for (const p of call.public_messages) {
      const again = seal(p.plaintext, run.model_key, { ephSecret: p.eph_secret, nonce: p.nonce }).wire;
      check(`${who}: public message ${p.index} re-encrypts to the exact bytes sent`, again === req.messages[p.index].content);
    }
    const prompt = call.public_messages.find((p) => p.index === 2).plaintext;
    check(`${who}: decision prompt contains the full public transcript`, run.transcript.every((l) => prompt.includes(l)));
    const answer = open(JSON.parse(call.response_body).choices[0].message.content, d.response_key);
    const parsed = parseDecision(answer);
    check(`${who}: decrypted answer says ${d.mv.toUpperCase()}`, parsed?.mv === d.mv, answer.slice(0, 60));
  }
  return rows;
}

if (process.argv[1].endsWith("verify.mjs")) {
  const rows = await verifyMatch(process.argv[2], process.argv[3]);
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  const fails = rows.filter((r) => !r.ok).length;
  console.log(fails ? `\n${fails} check(s) failed` : `\nall ${rows.length} checks passed`);
  process.exit(fails ? 1 : 0);
}
