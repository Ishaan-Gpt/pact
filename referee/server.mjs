// Pact referee server: serves the arena, seals nothing itself (browsers seal), runs matches, streams them.
import express from "express";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { cfg, nearView, nearCall } from "./lib/near.mjs";
import { sha256Hex } from "./lib/e2ee.mjs";
import { putSealed, allSealed } from "./lib/store.mjs";
import { runMatch } from "./match.mjs";
import { verifyMatch } from "./verify.mjs";
import { attest } from "./attest.mjs";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static("../web"));
app.use("/vendor/noble", express.static("node_modules/@noble"));
app.use("/demo", express.static("../demo"));
app.get("/lib/e2ee.mjs", (_q, r) => r.type("text/javascript").sendFile("lib/e2ee.mjs", { root: "." }));

let attestation = null;
async function freshAttestation() {
  if (!attestation || Date.now() - Date.parse(attestation.at) > 10 * 60_000) attestation = await attest();
  return attestation;
}

app.get("/api/info", async (_q, r) => {
  const [owner, referee, model, keys, jackpot, matches] = await nearView("info");
  r.json({ contract: cfg.contract, network: cfg.network, referee, model, modelKey: keys.at(-1), keys, jackpot, matches, live: !!cfg.apiKey });
});

app.get("/api/attestation", async (_q, r) => r.json(await freshAttestation()));

app.get("/api/agents", async (_q, r) => {
  const agents = await nearView("agents", { from: 0, limit: 200 });
  r.json(agents.sort((a, b) => b.elo - a.elo));
});

app.get("/api/matches", async (_q, r) => r.json(await nearView("recent_matches", { limit: 30 })));

app.get("/api/match/:id", (q, r) => {
  const f = `runs/match-${Number(q.params.id)}.json`;
  if (!existsSync(f)) return r.status(404).json({ error: "no run file" });
  r.type("json").send(readFileSync(f));
});

app.get("/api/verify/:id", async (q, r) => {
  try {
    r.json(await verifyMatch(Number(q.params.id)));
  } catch (e) {
    r.status(400).json({ error: String(e.message || e) });
  }
});

// A browser sends only ciphertext sealed to the enclave key, plus a name. The house funds a testnet stake.
app.post("/api/agents", async (q, r) => {
  try {
    const { id, name, wire, modelKey } = q.body || {};
    if (!/^[a-z0-9-]{3,24}$/.test(id || "")) throw new Error("id: 3-24 lowercase letters, digits or dashes");
    if (!name || name.length > 24) throw new Error("name: 1-24 characters");
    if (!/^[0-9a-f]+$/.test(wire || "") || wire.length < 120 || wire.length > 4000) throw new Error("wire must be sealed hex");
    const info = await nearView("info");
    if (modelKey !== info[3].at(-1)) throw new Error("sealed to an old enclave key; reload and seal again");
    if (await nearView("get_agent", { id })) throw new Error("that id is taken");
    putSealed(id, wire, modelKey);
    const agent = await nearCall(cfg.contract, "create_agent", { id, name, strategy_hash: sha256Hex(wire) }, { deposit: "0.5 NEAR", gas: "50 Tgas" });
    r.json(agent);
  } catch (e) {
    r.status(400).json({ error: String(e.message || e) });
  }
});

// Play: server-sent events while the match runs.
let busy = false;
app.get("/api/play", async (q, r) => {
  r.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  // A viewer leaving must never abort a match that has already locked stakes on chain.
  const send = (e) => {
    try {
      if (!r.writableEnded && !r.destroyed) r.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch {}
  };
  if (busy) return send({ type: "error", error: "a match is running, try again in a minute" }), r.end();
  busy = true;
  try {
    const { a, b } = q.query;
    let opp = b;
    if (!opp) {
      const agents = (await nearView("agents", { from: 0, limit: 200 })).filter((x) => x.id !== a && allSealed()[x.id]);
      opp = agents[Math.floor(Math.random() * agents.length)].id;
    }
    await runMatch(String(a), String(opp), 0.1, send);
  } catch (e) {
    console.error("play failed:", e);
    send({ type: "error", error: String(e.message || e) });
  } finally {
    busy = false;
    r.end();
  }
});

app.get("/api/runs", (_q, r) =>
  r.json(existsSync("runs") ? readdirSync("runs").filter((f) => f.startsWith("match-")).map((f) => Number(f.slice(6, -5))).sort((x, y) => y - x) : []),
);

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`Pact referee on http://localhost:${port} (contract ${cfg.contract}, live matches: ${!!cfg.apiKey})`));
