// Run one Pact match end to end: open on chain, one sealed talk turn per agent (in the contract's order),
// two sealed decisions, then settle. The contract re-checks every answer itself (signature, request and
// response bytes, public messages, sealed strategy) and decrypts the talk lines and moves on chain.
// Usage: node match.mjs <agentA> <agentB> [stakeNEAR]
import { writeFileSync, mkdirSync } from "node:fs";
import { cfg, nearView, nearCall, lastGas } from "./lib/near.mjs";
import { seal, sha256Hex } from "./lib/e2ee.mjs";
import { sealedChat } from "./lib/nearai.mjs";
import { RULES, talkPrompt, decidePrompt, parseDecision, cleanLine } from "./lib/game.mjs";
import { getSealed } from "./lib/store.mjs";

const yocto = (near) => (BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n).toString();
const toNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

export async function runMatch(aId, bId, stakeNear = 0.05, onEvent = () => {}, opts = {}) {
  const info = await nearView("info");
  const modelKey = info[3].at(-1);
  const sealed = { [aId]: getSealed(aId), [bId]: getSealed(bId) };
  for (const id of [aId, bId]) {
    const ag = await nearView("get_agent", { id });
    if (!ag) throw new Error(`unknown agent ${id}`);
    if (sha256Hex(sealed[id].wire) !== ag.strategy_hash) throw new Error(`stored strategy for ${id} does not match its on-chain hash`);
  }

  const m = await nearCall(cfg.contract, "open_match", { a: aId, b: bId, stake: yocto(stakeNear) });
  onEvent({ type: "open", match: m });
  const side = (id) => (id === m.a ? { me: m.name_a, opp: m.name_b, card: m.card_a } : { me: m.name_b, opp: m.name_a, card: m.card_b });

  // One enclave answer with its full proof. Public messages are sealed with secrets we publish.
  const ask = async (agent, prompt, kind, accept) => {
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        const r = seal(RULES, modelKey), p = seal(prompt, modelKey);
        const messages = [
          { role: "system", content: r.wire },
          { role: "user", content: sealed[agent].wire },
          { role: "user", content: p.wire },
        ];
        const res = await sealedChat({ messages, modelKey, maxTokens: kind === "decide" ? 900 : 500 });
        const bad = Object.entries(res.checks).filter(([, v]) => !v).map(([k]) => k);
        if (bad.length) throw new Error(`enclave proof failed: ${bad.join(", ")}`);
        if (!accept(res.content)) throw new Error(`unusable ${kind} answer: ${res.content.slice(0, 80)}`);
        return {
          content: res.content,
          answer: {
            agent_id: agent, text: res.signature.text, signature: res.signature.signature.replace(/^0x/, ""), tee_key: modelKey,
            request_body: res.requestBody, response_body: res.responseBody, response_key: res.responseKey,
            rules_seal: { eph_secret: r.ephSecret, nonce: r.nonce }, prompt_seal: { eph_secret: p.ephSecret, nonce: p.nonce },
          },
        };
      } catch (e) {
        lastErr = e;
        await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
      }
    }
    throw lastErr;
  };

  const order = m.first === m.a ? [m.a, m.b] : [m.b, m.a];
  const transcript = [], talk = [];
  for (const id of order) {
    const s = side(id);
    const { content, answer } = await ask(id, talkPrompt({ card: s.card, transcript: [...transcript], me: s.me, opp: s.opp }), "talk", (c) => c.trim().length > 0);
    const line = `${s.me}: ${cleanLine(content)}`;
    transcript.push(line);
    talk.push(answer);
    onEvent({ type: "talk", agent: id, line });
  }

  // Both decide from the same transcript, in parallel: neither sees the other's choice.
  const decide = (id) => ask(id, decidePrompt({ card: side(id).card, transcript, me: side(id).me }), "decide", (c) => !!parseDecision(c));
  const [da, db] = await Promise.all([decide(m.a), decide(m.b)]);
  onEvent({ type: "decided" });

  const settleArgs = { id: m.id, talk, decisions: [da.answer, db.answer] };
  mkdirSync("runs", { recursive: true });
  writeFileSync(`runs/pending-${m.id}.json`, JSON.stringify(settleArgs));
  if (opts.settle === false) return { settleArgs, modelKey, moves: { [m.a]: parseDecision(da.content).mv, [m.b]: parseDecision(db.content).mv } };
  const settled = await nearCall(cfg.contract, "settle", settleArgs, { gas: "300 Tgas" });
  const settleGas = lastGas.tgas;

  const result = {
    match_id: m.id, contract: cfg.contract, model: cfg.model, model_key: modelKey, stake: stakeNear,
    transcript: settled.transcript,
    moves: { [m.a]: settled.moves[0], [m.b]: settled.moves[1] },
    reveals: { [m.a]: settled.reveals[0], [m.b]: settled.reveals[1] },
    payout: { [m.a]: toNear(settled.payout_a), [m.b]: toNear(settled.payout_b), jackpot: toNear(settled.to_jackpot) },
    settle_gas_tgas: settleGas,
    talk, decisions: settleArgs.decisions,
  };
  writeFileSync(`runs/match-${m.id}.json`, JSON.stringify(result, null, 1));
  onEvent({ type: "settled", result });
  return result;
}

if (process.argv[1].endsWith("match.mjs")) {
  const [a, b, stake = "0.05"] = process.argv.slice(2);
  const r = await runMatch(a, b, Number(stake), (e) => e.type === "talk" && console.log(e.line));
  console.log(`\n${a}: ${r.moves[a]}  "${r.reveals[a]}"\n${b}: ${r.moves[b]}  "${r.reveals[b]}"`);
  console.log("payout", r.payout, `\nsettled on chain: match ${r.match_id} at ${cfg.contract}`);
}
