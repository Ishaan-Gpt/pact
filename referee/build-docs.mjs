// Builds docs/: a static, read-only Pact arena for GitHub Pages. It reads the contract from a NEAR RPC node,
// replays the published runs and audits them in the visitor's browser. Usage: node build-docs.mjs
import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const out = "../docs";
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) rmSync(`${out}/${f}`, { recursive: true, force: true }); // empty it in place (a server may hold the folder)
mkdirSync(`${out}/runs`, { recursive: true });
mkdirSync(`${out}/lib`, { recursive: true });
for (const f of readdirSync("../web")) cpSync(`../web/${f}`, `${out}/${f}`, { recursive: true });
for (const f of ["e2ee.mjs", "game.mjs"]) cpSync(`lib/${f}`, `${out}/lib/${f}`);
for (const p of ["curves", "hashes", "ciphers"])
  cpSync(`node_modules/@noble/${p}`, `${out}/vendor/noble/${p}`, { recursive: true, filter: (s) => !/\.(ts|map|md)$/.test(s) && !/[\/](src|test)[\/]?/.test(s.split(`@noble`)[1] ?? "") });
const runs = readdirSync("runs").filter((f) => /^match-\d+\.json$/.test(f)).map((f) => Number(f.slice(6, -5))).sort((a, b) => b - a);
for (const id of runs) cpSync(`runs/match-${id}.json`, `${out}/runs/match-${id}.json`);
writeFileSync(`${out}/runs/index.json`, JSON.stringify(runs));
const att = JSON.parse(readFileSync("runs/attestation.json", "utf8"));
delete att.raw;
writeFileSync(`${out}/runs/attestation-summary.json`, JSON.stringify(att, null, 1));
writeFileSync(`${out}/.nojekyll`, "");
console.log(`docs/ built: ${runs.length} matches`);
