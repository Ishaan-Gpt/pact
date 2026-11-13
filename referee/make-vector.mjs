// Contract test vectors built exactly like real NEAR AI end-to-end-encrypted answers: real E2EE v2 to a
// stand-in enclave ed25519 key, real request/response bodies, the real public prompts, ed25519 signatures.
// Writes contract/tests/vector.json. Usage: node make-vector.mjs
import { writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { seal, clientKey, sha256Hex, bytesToHex } from "./lib/e2ee.mjs";
import { RULES, talkPrompt, decidePrompt, cleanLine } from "./lib/game.mjs";

const model = "z-ai/glm-5.3-flash";
const sk = ed25519.utils.randomSecretKey();
const teeKey = bytesToHex(ed25519.getPublicKey(sk));
const card = (name) => `Your opponent is "${name}" (Elo 1000). Its record: 0 games, split 0, stole 0.`;
const strat = { fox: seal("Your owner's strategy: split with friends.", teeKey).wire, owl: seal("Your owner's strategy: mirror them.", teeKey).wire };
const names = { fox: "Fox", owl: "Owl" };

function answer(agent, prompt, said, { strategyWire = strat[agent] } = {}) {
  const r = seal(RULES, teeKey), p = seal(prompt, teeKey), ck = clientKey();
  const request_body = JSON.stringify({ model, messages: [
    { role: "system", content: r.wire }, { role: "user", content: strategyWire }, { role: "user", content: p.wire } ], stream: false, max_tokens: 500, temperature: 0.7 });
  const response_body = JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, message: { role: "assistant", content: seal(said, ck.pubHex).wire } }] });
  const text = `${model}:${sha256Hex(request_body)}:${sha256Hex(response_body)}`;
  return { agent_id: agent, text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), sk)), tee_key: teeKey,
    request_body, response_body, response_key: ck.responseKey,
    rules_seal: { eph_secret: r.ephSecret, nonce: r.nonce }, prompt_seal: { eph_secret: p.ephSecret, nonce: p.nonce } };
}

// fox speaks first (the unit-test random seed is all zeros, so `a` goes first)
const lines = { fox: '"I split with anyone who splits with me."', owl: "Then we both go home happy." };
const t0 = answer("fox", talkPrompt({ card: card("Owl"), transcript: [], me: "Fox", opp: "Owl" }), lines.fox);
const transcript = [`Fox: ${cleanLine(lines.fox)}`];
const t1 = answer("owl", talkPrompt({ card: card("Fox"), transcript, me: "Owl", opp: "Fox" }), lines.owl);
transcript.push(`Owl: ${cleanLine(lines.owl)}`);
const dec = (agent, mv) => answer(agent, decidePrompt({ card: card(agent === "fox" ? "Owl" : "Fox"), transcript, me: names[agent] }),
  `<think>weighing it</think>{"move":"${mv}","reveal":"${mv === "SPLIT" ? "Told you." : "Nothing personal."}"}`);

const out = {
  model, tee_key: teeKey, transcript,
  strategy_hash_fox: sha256Hex(strat.fox), strategy_hash_owl: sha256Hex(strat.owl),
  talk: [t0, t1],
  split_split: [dec("fox", "SPLIT"), dec("owl", "SPLIT")],
  steal_split: [dec("fox", "STEAL"), dec("owl", "SPLIT")],
  steal_steal: [dec("fox", "STEAL"), dec("owl", "STEAL")],
  // the referee lies in the prompt: tells Owl that Fox promised a lot more than it did
  lying_prompt: dec("owl", "SPLIT") && answer("owl", decidePrompt({ card: card("Fox"), transcript: [transcript[0], "Owl: I trust you completely."], me: "Owl" }), '{"move":"SPLIT","reveal":"ok"}'),
  // the referee sends Owl's request with Fox's strategy
  wrong_strategy: answer("owl", decidePrompt({ card: card("Fox"), transcript, me: "Owl" }), '{"move":"STEAL","reveal":"x"}', { strategyWire: strat.fox }),
  // the referee swaps in its own encrypted STEAL under the same response key (re-encrypted answer)
  forged_answer: (() => {
    const real = dec("owl", "SPLIT");
    const ck = { pubHex: bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey())) };
    return { ...real, response_body: JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, message: { role: "assistant", content: seal('{"move":"STEAL","reveal":"x"}', ck.pubHex).wire } }] }) };
  })(),
};
writeFileSync("../contract/tests/vector.json", JSON.stringify(out, null, 1));
console.log("wrote contract/tests/vector.json; transcript:", transcript);
