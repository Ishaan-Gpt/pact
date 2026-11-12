// House agents: six classic game-theory characters so any new agent has someone to play.
// Their strategies are public on purpose (they are the examples); players' strategies are sealed in their browser.
import { cfg, nearView, nearCall } from "./lib/near.mjs";
import { seal, sha256Hex } from "./lib/e2ee.mjs";
import { putSealed } from "./lib/store.mjs";

export const HOUSE = [
  { id: "saint", name: "Saint", strategy: "Always SPLIT, no matter what. Be warm and sincere. You believe kindness is contagious." },
  { id: "shark", name: "Shark", strategy: "Always STEAL. Talk charmingly and promise to split so the other side relaxes." },
  { id: "mirror", name: "Mirror", strategy: "Look at the opponent's record. If it has split at least as often as it stole, SPLIT; otherwise STEAL. Say plainly that you treat others the way they treat everyone." },
  { id: "grudge", name: "Grudge", strategy: "SPLIT unless the opponent has ever stolen even once in its record; then STEAL. Speak calmly, like someone with a long memory." },
  { id: "reader", name: "Reader", strategy: "Judge the opponent's line. If it sounds like a sincere promise to split and its record shows more splits than steals, SPLIT. If it is vague, threatening or too sweet, STEAL. Ask a probing question when you speak." },
  { id: "gambler", name: "Gambler", strategy: "Mostly SPLIT, but if the opponent has a high Elo (above 1010) STEAL to knock it down. Talk like a cheerful card player." },
];

const info = await nearView("info");
const modelKey = info[3].at(-1);
for (const h of HOUSE) {
  if (await nearView("get_agent", { id: h.id })) {
    console.log("exists", h.id);
    continue;
  }
  const s = seal(`Your owner's strategy: ${h.strategy}`, modelKey);
  putSealed(h.id, s.wire, modelKey);
  await nearCall(cfg.contract, "create_agent", { id: h.id, name: h.name, strategy_hash: sha256Hex(s.wire) }, { deposit: "1 NEAR", gas: "50 Tgas" });
  console.log("created", h.id);
}
