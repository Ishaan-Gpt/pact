// The public audit (referee/verify.mjs), running in the visitor's browser: the on-chain record from a NEAR
// RPC node plus the published run file. Nothing here trusts the Pact server.
import { ed25519 } from "@noble/curves/ed25519.js";
import { view } from "./chain.js";
import { seal, open, sha256Hex, hexToBytes } from "./lib/e2ee.mjs";
import { RULES, talkPrompt, decidePrompt, parseDecision, cleanLine } from "./lib/game.mjs";

export async function verifyMatch(id, runUrl = `runs/match-${id}.json`) {
  const [m, info, run] = await Promise.all([view("get_match", { id: Number(id) }), view("info"), fetch(runUrl).then((r) => r.json())]);
  const rows = [];
  const check = (name, ok, note = "") => rows.push({ name, ok: !!ok, note });
  check("match is settled on chain", m?.status === "Settled", m?.status);
  const side = (who) => (who === m.a ? { me: m.name_a, opp: m.name_b, card: m.card_a, strat: m.strategy_a } : { me: m.name_b, opp: m.name_a, card: m.card_b, strat: m.strategy_b });

  const one = (a, prompt, label) => {
    const s = side(a.agent_id);
    const parts = a.text.split(":");
    const [model, reqHash, respHash] = [parts.slice(0, -2).join(":"), parts.at(-2), parts.at(-1)];
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
