// Builds plan.json: scene URLs, timed actions, and replay speeds that fit each match into its voice beat.
// Usage: node plan.mjs <hookMatchId> <playedMatchId|latest> <handle>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const voice = Object.fromEntries(JSON.parse(readFileSync("out/voice.json", "utf8")).map((v) => [v.id, v]));
const [hookId = "0", playedId = "latest", handle = "velvet"] = process.argv.slice(2);
const runFile = (id) => `../referee/runs/match-${id}.json`;
const latest = () => Math.max(...JSON.parse(readFileSync("../referee/runs/tournament.tsv", "utf8").trim().split("\n").map((l) => l.split("\t")[0]).map(Number)));
function speedFor(id, beat, skip = 0) {
  if (!existsSync(runFile(id))) return 1.6;
  const run = JSON.parse(readFileSync(runFile(id), "utf8"));
  const talk = run.transcript.reduce((a, l) => a + Math.max(2.6, 0.9 + (l.length - l.indexOf(": ") - 2) * 0.045), 0);
  const total = 0.6 + 1.2 + talk + 1.8 + 2.6 + 3.4;
  return +((total - skip) / (voice[beat].dur + 0.2)).toFixed(2);
}
// The hook opens with the first speaker's promise already typed, so the stamp meets "stole every coin".
const HOOK_SKIP = 6.6;
const plan = {
  scenes: [
    { id: "hook", url: `/?match=${hookId}&focus=1&speed=${speedFor(hookId, "hook", HOOK_SKIP)}`, load: 800, before: [["waitFor", "window.pactArena && pactArena.match"], ["wait", 300]],
      during: [[0, "eval", `pactArena.start = performance.now() - ${HOOK_SKIP} * 1000 / pactArena.speed`]] },
    { id: "seal", url: "/", load: 2200, before: [["jump", "#play"]],
      during: [[0.4, "type", "input[name=name]", "Juniper", 18], [1.0, "type", "input[name=id]", handle, 18],
               [2.0, "type", "textarea[name=strategy]", "Split with anyone whose record shows more splits than steals. If they promise too sweetly, steal first. Never reveal this.", 42],
               [6.2, "click", ".stamp-btn"]] },
    { id: "match", url: `/?match=${playedId}&focus=1&speed=${playedId === "latest" ? 1.6 : speedFor(playedId, "match")}`, load: 800, before: [["waitFor", "window.pactArena && pactArena.match"], ["wait", 300]], during: [[0, "eval", "pactArena.start = performance.now()"]] },
    { id: "proof", url: "/", load: 2600, before: [["waitFor", "document.querySelectorAll(\"#checks li\").length > 10"], ["jump", "#proof"], ["wait", 600], ["jump", "#proof"]], during: [[0, "jump", "#proof"], [3.0, "glide", 760, 9500]] },
    { id: "break", url: "/demo/term.html?step=360", load: 1500 },
    { id: "ladder", url: "/", load: 2200, before: [["jump", "#ladder"]], endCard: "github.com/Ishaan-Gpt/pact  ·  game.pact-arena.testnet" },
  ],
};
writeFileSync("plan.json", JSON.stringify(plan, null, 1));
console.log(plan.scenes.map((s) => `${s.id}: ${s.url}`).join("\n"));
