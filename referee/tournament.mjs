// Round-robin tournament between every agent with a stored sealed strategy. Every match settles on chain.
// Usage: node tournament.mjs [rounds=1] [stake=0.05]
import { appendFileSync } from "node:fs";
import { nearView } from "./lib/near.mjs";
import { allSealed } from "./lib/store.mjs";
import { runMatch } from "./match.mjs";

const rounds = Number(process.argv[2] || 1), stake = Number(process.argv[3] || 0.05);
const ids = Object.keys(allSealed());
const pairs = [];
for (let r = 0; r < rounds; r++)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push(r % 2 ? [ids[j], ids[i]] : [ids[i], ids[j]]);
let ok = 0, fail = 0;
for (const [a, b] of pairs) {
  const t = Date.now();
  try {
    const agents = Object.fromEntries((await nearView("agents", { from: 0, limit: 200 })).map((x) => [x.id, x]));
    if (BigInt(agents[a].balance) < BigInt(Math.round(stake * 1e6)) * 10n ** 18n || BigInt(agents[b].balance) < BigInt(Math.round(stake * 1e6)) * 10n ** 18n) {
      console.log(`skip ${a} v ${b}: broke`);
      continue;
    }
    const r = await runMatch(a, b, stake);
    ok++;
    const line = `${r.match_id}\t${a}\t${r.moves[a]}\t${b}\t${r.moves[b]}\t${((Date.now() - t) / 1000).toFixed(1)}s`;
    console.log(line);
    appendFileSync("runs/tournament.tsv", line + "\n");
  } catch (e) {
    fail++;
    console.log(`FAIL ${a} v ${b}: ${String(e.message || e).slice(0, 160)}`);
  }
}
console.log(`done: ${ok} settled, ${fail} failed`);
