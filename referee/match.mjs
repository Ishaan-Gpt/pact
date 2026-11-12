// Run one Pact match end to end: open on chain, one sealed talk turn per agent, two sealed decisions,
// settle on chain with the enclave's signatures, and save every byte needed to audit it.
// Usage: node match.mjs <agentA> <agentB> [stakeNEAR]
import { writeFileSync, mkdirSync } from "node:fs";
import { cfg, nearView, nearCall } from "./lib/near.mjs";
import { seal, sha256Hex } from "./lib/e2ee.mjs";
import { sealedChat } from "./lib/nearai.mjs";
import { rules, talkPrompt, decidePrompt, parseDecision, cleanLine } from "./lib/game.mjs";
import { getSealed } from "./lib/store.mjs";

const yocto = (near) => (BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n).toString();
const toNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

export async function runMatch(aId, bId, stakeNear = 1, onEvent = () => {}) {
  const [info, A, B] = await Promise.all([nearView("info"), nearView("get_agent", { id: aId }), nearView("get_agent", { id: bId })]);
  const modelKey = info[3].at(-1);
  if (!A || !B) throw new Error("unknown agent");
  const sealed = { [aId]: getSealed(aId), [bId]: getSealed(bId) };
  for (const ag of [A, B]) {
    if (sha256Hex(sealed[ag.id].wire) !== ag.strategy_hash) throw new Error(`stored strategy for ${ag.id} does not match its on-chain hash`);
  }

  const opened = await nearCall(cfg.contract, "open_match", { a: aId, b: bId, stake: yocto(stakeNear) });
  const m = opened;
  onEvent({ type: "open", match: m });
  const pot = stakeNear * 2;
  const rulesText = rules({ stake: stakeNear, pot });
  const log = { match_id: m.id, contract: cfg.contract, model: cfg.model, model_key: modelKey, stake: stakeNear, calls: [] };

  // Build a request: public messages are sealed with published ephemeral secrets; the strategy is the owner's own seal.
  const ask = async (ag, opp, prompt, kind) => {
    const pub1 = seal(rulesText, modelKey);
    const pub2 = seal(prompt, modelKey);
    const messages = [
      { role: "system", content: pub1.wire },
      { role: "user", content: sealed[ag.id].wire },
      { role: "user", content: pub2.wire },
    ];
    const r = await sealedChat({ messages, modelKey });
    const bad = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
    if (bad.length) throw new Error(`enclave proof failed for ${ag.id} ${kind}: ${bad.join(", ")}`);
    log.calls.push({
      agent: ag.id, kind, chat_id: r.chatId, request_body: r.requestBody, response_body: r.responseBody,
      response_key: r.responseKey, signature: r.signature,
      public_messages: [{ index: 0, plaintext: rulesText, eph_secret: pub1.ephSecret, nonce: pub1.nonce },
                        { index: 2, plaintext: prompt, eph_secret: pub2.ephSecret, nonce: pub2.nonce }],
      sealed_strategy_index: 1, answer: r.content,
    });
    return r;
  };

  const order = m.first === aId ? [[A, B], [B, A]] : [[B, A], [A, B]];
  const transcript = [];
  for (const [me, opp] of order) {
    const r = await ask(me, opp, talkPrompt({ me, opp, transcript: [...transcript] }), "talk");
    const line = `${me.name}: ${cleanLine(r.content)}`;
    transcript.push(line);
    onEvent({ type: "talk", agent: me.id, line });
  }

  const transcriptHash = sha256Hex(transcript.join("\n"));
  const decide = async (me, opp) => {
    for (let tries = 0; tries < 3; tries++) {
      const r = await ask(me, opp, decidePrompt({ me, opp, transcript }), "decide");
      const d = parseDecision(r.content);
      if (d) {
        return {
          reveal: d.reveal,
          decision: {
            agent_id: me.id, mv: d.mv, text: r.signature.text, signature: r.signature.signature.replace(/^0x/, ""),
            tee_key: modelKey, transcript_hash: transcriptHash, strategy_hash: me.strategy_hash, response_key: r.responseKey,
          },
        };
      }
    }
    throw new Error(`${me.id} gave no valid decision`);
  };
  // Both decide from the same transcript, in parallel: neither sees the other's choice.
  const [da, db] = await Promise.all([decide(A, B), decide(B, A)]);
  onEvent({ type: "decided" });

  const settled = await nearCall(cfg.contract, "settle", { id: m.id, transcript, decisions: [da.decision, db.decision] });
  const result = {
    ...log, transcript, transcript_hash: transcriptHash,
    reveals: { [aId]: da.reveal, [bId]: db.reveal },
    moves: { [aId]: da.decision.mv, [bId]: db.decision.mv },
    payout: { [aId]: toNear(settled.payout_a), [bId]: toNear(settled.payout_b), jackpot: toNear(settled.to_jackpot) },
  };
  mkdirSync("runs", { recursive: true });
  writeFileSync(`runs/match-${m.id}.json`, JSON.stringify(result, null, 1));
  onEvent({ type: "settled", result });
  return result;
}

if (process.argv[1].endsWith("match.mjs")) {
  const [a, b, stake = "1"] = process.argv.slice(2);
  const r = await runMatch(a, b, Number(stake), (e) => e.type === "talk" && console.log(e.line));
  console.log(`\n${a}: ${r.moves[a]}  "${r.reveals[a]}"\n${b}: ${r.moves[b]}  "${r.reveals[b]}"`);
  console.log("payout", r.payout, `\nsettled on chain: match ${r.match_id} at ${cfg.contract}`);
}
