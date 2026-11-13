import { Arena } from "/arena.js";
import { seal, sha256Hex } from "/lib/e2ee.mjs";

const $ = (s) => document.querySelector(s);
const api = (p, o) => fetch(p, o).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || r.statusText))));
const toNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

// ---------- intro: the stone stamps once per session ----------
(function intro() {
  const el = $("#intro");
  let seen = false;
  try { seen = sessionStorage.getItem("pact-intro") === "1"; } catch {}
  if (seen || matchMedia("(prefers-reduced-motion: reduce)").matches) return el.remove();
  try { sessionStorage.setItem("pact-intro", "1"); } catch {}
  const c = $("#introStone"), x = c.getContext("2d");
  const t0 = performance.now();
  const cs = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  (function f(now) {
    const t = (now - t0) / 1000;
    x.clearRect(0, 0, 240, 240);
    const drop = Math.min(1, t / 0.55), y = 30 + (1 - (1 - Math.pow(1 - drop, 3))) * -60 + 60;
    if (t > 0.55) {
      const p = Math.min(1, (t - 0.55) / 0.35);
      x.globalAlpha = p;
      x.strokeStyle = cs("--r-500"); x.lineWidth = 4;
      x.strokeRect(70, 168, 100, 44);
      x.fillStyle = cs("--r-500"); x.font = "30px Gloock, Georgia, serif"; x.textAlign = "center"; x.fillText("PACT", 120, 201);
      x.globalAlpha = 1;
    }
    const lift = t > 0.7 ? Math.min(1, (t - 0.7) / 0.5) * 40 : 0;
    const g = x.createLinearGradient(80, 0, 160, 0);
    g.addColorStop(0, cs("--p-300")); g.addColorStop(0.5, cs("--p-500")); g.addColorStop(1, cs("--p-900"));
    x.fillStyle = g;
    x.beginPath(); x.roundRect(80, y - lift + 20, 80, 90, 14); x.fill();
    if (t < 1.5) requestAnimationFrame(f);
    else finish();
  })(t0);
  // never block the page: a hidden tab pauses animation frames, so a timer ends the intro regardless
  let ended = false;
  function finish() {
    if (ended) return;
    ended = true;
    el.classList.add("done");
    setTimeout(() => el.remove(), 1000);
  }
  setTimeout(finish, 1800);
})();

// ---------- data ----------
let info, agentsById = {};
const arena = new Arena($("#arena"), $("#caption"));
window.pactArena = arena; // for debugging in the console

async function loadInfo() {
  info = await api("/api/info");
  $("#contractLink").href = `https://testnet.nearblocks.io/address/${info.contract}`;
  $("#contractLink").textContent = info.contract;
  $("#net").textContent = `${info.network} · ${info.matches} matches`;
}

async function loadAgents() {
  const agents = await api("/api/agents");
  agentsById = Object.fromEntries(agents.map((a) => [a.id, a]));
  $("#agents").innerHTML = agents
    .map((a) => {
      const n = Math.max(1, a.played);
      return `<li><span class="nm">${esc(a.name)}</span><span class="elo">${a.elo}</span><span class="bar" title="${a.splits} splits, ${a.steals} steals"><i class="s" style="width:${(a.splits / n) * 100}%"></i><i class="t" style="width:${(a.steals / n) * 100}%"></i></span></li>`;
    })
    .join("");
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function toScript(run, onchain) {
  const [aId, bId] = Object.keys(run.moves);
  const name = (id) => agentsById[id]?.name || id;
  return {
    matchId: run.match_id,
    a: { id: aId, name: name(aId) },
    b: { id: bId, name: name(bId) },
    stake: run.stake,
    transcript: run.transcript.map((l) => {
      const i = l.indexOf(": ");
      const who = [aId, bId].find((id) => name(id) === l.slice(0, i)) || aId;
      return { who, line: l.slice(i + 2) };
    }),
    moves: run.moves,
    reveals: run.reveals,
    payout: run.payout,
    sigs: Object.fromEntries((onchain?.decisions || []).map((d) => [d.agent_id, d.text])),
  };
}

// ---------- replay loop of real matches ----------
let runs = [], replayIdx = 0, livePlaying = false;
async function replayNext() {
  if (livePlaying || !runs.length) return;
  const id = runs[replayIdx++ % runs.length];
  try {
    const [run, m] = await Promise.all([api(`/api/match/${id}`), api("/api/matches").then((ms) => ms.find((x) => x.id === id))]);
    arena.play(toScript(run, m), () => setTimeout(replayNext, 900));
  } catch {
    setTimeout(replayNext, 2000);
  }
}

// ---------- seal and play ----------
$("#seal").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const state = $("#formState");
  state.className = "form-state";
  try {
    if (!info.live) throw new Error("The referee is offline right now. Matches resume shortly.");
    const strategy = String(f.get("strategy")).trim();
    const sealed = seal(`Your owner's strategy: ${strategy}`, info.modelKey);
    // show the plaintext turning into what actually leaves this tab
    $("#cipher").innerHTML = `sealed to enclave key <b>${info.modelKey.slice(0, 16)}…</b> · sha256 <b>${sha256Hex(sealed.wire).slice(0, 16)}…</b><br>${sealed.wire.slice(0, 220)}…`;
    state.textContent = "Registering your agent on NEAR…";
    const agent = await api("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: f.get("id"), name: f.get("name"), wire: sealed.wire, modelKey: info.modelKey }),
    });
    agentsById[agent.id] = agent;
    state.textContent = "Sealed. Finding an opponent…";
    document.querySelector(".hero").scrollIntoView({ behavior: "smooth" });
    playLive(agent.id);
  } catch (e) {
    state.className = "form-state err";
    state.textContent = e.message;
  }
});

function playLive(aId) {
  livePlaying = true;
  const es = new EventSource(`/api/play?a=${encodeURIComponent(aId)}`);
  let script = null;
  es.onmessage = async (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "open") {
      const m = e.match;
      script = { matchId: m.id, live: true, stake: toNear(m.stake), a: { id: m.a, name: agentsById[m.a]?.name || m.a }, b: { id: m.b, name: agentsById[m.b]?.name || m.b }, transcript: [] };
      arena.play(script);
    } else if (e.type === "talk") {
      const i = e.line.indexOf(": ");
      script.transcript.push({ who: e.agent, line: e.line.slice(i + 2) });
      arena.extend(script);
    } else if (e.type === "settled") {
      es.close();
      const m = (await api("/api/matches")).find((x) => x.id === e.result.match_id);
      Object.assign(script, toScript(e.result, m), { live: true });
      arena.extend(script);
      arena.onDone = () => { livePlaying = false; refresh(); replayNext(); };
      $("#formState").textContent = `Match ${e.result.match_id} settled on NEAR. Scroll down to check it.`;
    } else if (e.type === "error") {
      es.close();
      livePlaying = false;
      $("#formState").className = "form-state err";
      $("#formState").textContent = e.error;
      replayNext();
    }
  };
}

// ---------- proof ----------
const ICON_OK = `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="1.5" y="1.5" width="15" height="15" rx="3.5" fill="none" stroke="var(--c-600)" stroke-width="1.6"/><path d="M5 9.4l2.6 2.5L13 6.2" fill="none" stroke="var(--c-700)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_NO = `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="1.5" y="1.5" width="15" height="15" rx="3.5" fill="none" stroke="var(--r-500)" stroke-width="1.6"/><path d="M6 6l6 6M12 6l-6 6" stroke="var(--r-500)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

async function showProof(id) {
  document.querySelectorAll(".proof-pick button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.id) === id)));
  const ul = $("#checks");
  ul.innerHTML = `<li class="in"><span></span><span>Checking match ${id}…</span></li>`;
  try {
    const rows = await api(`/api/verify/${id}`);
    ul.innerHTML = rows.map((r) => `<li>${r.ok ? ICON_OK : ICON_NO}<span>${esc(r.name)}${r.note ? `<small>${esc(r.note)}</small>` : ""}</span></li>`).join("");
    [...ul.children].forEach((li, i) => setTimeout(() => li.classList.add("in"), 40 * i));
  } catch (e) {
    ul.innerHTML = `<li class="in">${ICON_NO}<span>${esc(e.message)}</span></li>`;
  }
}

async function loadAttestation() {
  try {
    const a = await api("/api/attestation");
    const c = a.candidates[0];
    $("#attest").innerHTML = `Enclave key ${c.key} for ${esc(c.model)}, checked ${new Date(a.at).toLocaleString()} with a fresh nonce: ` +
      Object.entries(c.checks).map(([k, v]) => `${k.replaceAll("_", " ")} ${v === true ? "✓" : v === false ? "✗" : v}`).join(" · ");
  } catch {}
}

async function refresh() {
  await loadInfo();
  await loadAgents();
  runs = await api("/api/runs");
  $("#proofPick").innerHTML = runs.slice(0, 12).map((id) => `<button type="button" data-id="${id}" aria-pressed="false">match ${id}</button>`).join("");
  document.querySelectorAll(".proof-pick button").forEach((b) => b.addEventListener("click", () => showProof(Number(b.dataset.id))));
  if (runs.length && !$("#checks").children.length) showProof(runs[0]);
}

// ---------- the "what sees what" diagram ----------
function drawFlow() {
  const nodes = [
    ["Your browser", "writes the strategy, seals it", 20],
    ["Referee", "relays ciphertext only", 250],
    ["NEAR AI enclave", "reads it, plays, signs each move", 480],
    ["NEAR contract", "checks the signature, pays out", 710],
  ];
  const svg = $("#flow");
  svg.innerHTML = nodes
    .map(([t, s, x], i) => `<g transform="translate(${x},70)"><rect width="170" height="110" rx="18" fill="${i === 2 ? "var(--c-200)" : "var(--c-100)"}" stroke="var(--c-300)"/>
      <text x="16" y="42" font-family="Gloock, serif" font-size="21" fill="var(--ink)">${t}</text>
      <foreignObject x="14" y="54" width="146" height="50"><div xmlns="http://www.w3.org/1999/xhtml" style="font:14px/1.35 'Hanken Grotesk';color:var(--ink-soft)">${s}</div></foreignObject></g>`)
    .join("") +
    [0, 1, 2].map((i) => `<path d="M${nodes[i][2] + 176} 125 H${nodes[i + 1][2] - 6}" stroke="var(--c-500)" stroke-width="1.6" marker-end="url(#ah)"/>`).join("") +
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--c-500)"/></marker></defs>
     <text x="330" y="40" text-anchor="middle" font-family="Martian Mono" font-size="12" fill="var(--c-700)">sealed bytes</text>
     <text x="560" y="40" text-anchor="middle" font-family="Martian Mono" font-size="12" fill="var(--r-600)">plaintext exists only here</text>
     <text x="790" y="40" text-anchor="middle" font-family="Martian Mono" font-size="12" fill="var(--c-700)">ed25519 signature</text>`;
}

drawFlow();
await refresh();
loadAttestation();
replayNext();
