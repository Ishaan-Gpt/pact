// Audit any settled match yourself, off chain, from the on-chain record plus runs/match-<id>.json.
// The contract already ran these checks before paying; this lets anyone re-run them on their own machine.
// Usage: node verify.mjs <matchId> [path/to/match.json]
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { nearView } from "./lib/near.mjs";
import { seal, open, sha256Hex, hexToBytes } from "./lib/e2ee.mjs";
import { RULES, talkPrompt, decidePrompt, parseDecision, cleanLine } from "./lib/game.mjs";

export async function verifyMatch(id, file = `runs/match-${id}.json`) {
  const m = await nearView("get_match", { id: Number(id) });
  const info = await nearView("info");
  const run = JSON.parse(readFileSync(file, "utf8"));
  const rows = [];
  const check = (name, ok, note = "") => rows.push({ name, ok: !!ok, note });

  check("match is settled on chain", m?.status === "Settled", m?.status);
  const side = (who) => (who === m.a ? { me: m.name_a, opp: m.name_b, card: m.card_a, strat: m.strategy_a } : { me: m.name_b, opp: m.name_a, card: m.card_b, strat: m.strategy_b });

  const one = (a, prompt, label) => {
    const s = side(a.agent_id);
    const [model, reqHash, respHash] = [a.text.split(":").slice(0, -2).join(":"), ...a.text.split(":").slice(-2)];
    check(`${label}: signed with a registered enclave key`, info[3].includes(a.tee_key), a.tee_key.slice(0, 16) + "...");
    check(`${label}: enclave signature verifies (ed25519)`, ed25519.verify(hexToBytes(a.signature), new TextEncoder().encode(a.text), hexToBytes(a.tee_key)));
    check(`${label}: signed by the model enclave ${model}`, model === info[2]);
    check(`${label}: sha256 of the request bytes matches`, sha256Hex(a.request_body) === reqHash);
    check(`${label}: sha256 of the response bytes matches`, sha256Hex(a.response_body) === respHash);
    const msgs = JSON.parse(a.request_body).messages;
    check(`${label}: sealed message is the agent's own strategy`, sha256Hex(msgs[1].content) === s.strat, "unreadable here, by design");
    check(`${label}: rules re-encrypt to the exact bytes sent`, seal(RULES, a.tee_key, { ephSecret: a.rules_seal.eph_secret, nonce: a.rules_seal.nonce }).wire === msgs[0].content);
    check(`${label}: prompt re-encrypts to the exact bytes sent`, seal(prompt, a.tee_key, { ephSecret: a.prompt_seal.eph_secret, nonce: a.prompt_seal.nonce }).wire === msgs[2].content);
    return open(JSON.parse(a.response_body).choices[0].message.content, a.response_key);
  };

  const transcript = [];
  for (const t of run.talk) {
    const s = side(t.agent_id);
    const said = one(t, talkPrompt({ card: s.card, transcript: [...transcript], me: s.me, opp: s.opp }), `${t.agent_id} talk`);
    transcript.push(`${s.me}: ${cleanLine(said)}`);
  }
  check("transcript rebuilt from the signed talk = the contract's transcript", JSON.stringify(transcript) === JSON.stringify(m.transcript));
  for (const [i, who] of [m.a, m.b].entries()) {
    const d = run.decisions.find((x) => x.agent_id === who);
    const said = one(d, decidePrompt({ card: side(who).card, transcript, me: side(who).me }), `${who} decision`);
    const p = parseDecision(said);
    check(`${who}: decrypted decision says ${m.moves[i].toUpperCase()}, as the contract paid`, p?.mv === m.moves[i], said.replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 70));
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
