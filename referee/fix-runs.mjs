// Rewrite runs/match-<id>.json for matches settled outside match.mjs, from the final on-chain record.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cfg, near } from "./lib/near.mjs";
const toNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
for (const id of process.argv.slice(2).map(Number)) {
  const m = await near().view(cfg.contract, "get_match", { id }, { finality: "final" });
  if (m.status !== "Settled") { console.log(id, m.status); continue; }
  const f = `runs/match-${id}.json`, p = `runs/pending-${id}.json`;
  const prev = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  const args = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : prev;
  writeFileSync(f, JSON.stringify({ match_id: id, contract: cfg.contract, model: cfg.model, model_key: prev.model_key, stake: toNear(m.stake),
    transcript: m.transcript, moves: { [m.a]: m.moves[0], [m.b]: m.moves[1] }, reveals: { [m.a]: m.reveals[0], [m.b]: m.reveals[1] },
    payout: { [m.a]: toNear(m.payout_a), [m.b]: toNear(m.payout_b), jackpot: toNear(m.to_jackpot) }, talk: args.talk, decisions: args.decisions }, null, 1));
  console.log(id, "rewritten:", m.moves.join(" v "));
}
