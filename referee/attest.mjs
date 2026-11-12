// Prove the NEAR AI model key lives in a genuine, non-debug Intel TDX enclave, bound to a nonce we chose now.
// Usage: node attest.mjs [--register]   (--register also adds the key to the Pact contract as owner)
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { js_get_collateral, js_verify } from "@phala/dcap-qvl-node";
import { cfg, nearCall } from "./lib/near.mjs";

const PCCS = "https://pccs.phala.network/sgx/certification/v4/";

export async function attest(model = cfg.model) {
  const nonce = randomBytes(32).toString("hex");
  const url = new URL("https://cloud-api.near.ai/v1/attestation/report");
  for (const [k, v] of Object.entries({ model, provider: "near", signing_algo: "ed25519", include_tls_fingerprint: "false", nonce }))
    url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "x-no-aliasing": "true", accept: "application/json" } });
  if (!res.ok) throw new Error(`attestation report ${res.status}: ${await res.text()}`);
  const report = await res.json();
  const cands = report.model_attestations || [];
  if (!cands.length) throw new Error("no model attestation returned");

  const verified = [];
  for (const m of cands) {
    const checks = {};
    const quote = Buffer.from(m.intel_quote, "hex");
    const key = (m.signing_public_key || m.signing_address).toLowerCase();
    checks.algo = m.signing_algo === "ed25519";
    checks.nonce_echoed = m.request_nonce === nonce;
    // TDX quote v4: 48-byte header, then the TD report body; report_data is the last 64 bytes of the body.
    checks.quote_v4_tdx = quote.readUInt16LE(0) === 4 && quote.readUInt32LE(4) === 0x81;
    const reportData = quote.subarray(568, 632).toString("hex");
    checks.key_bound_in_quote = reportData.slice(0, 64) === key;
    checks.nonce_bound_in_quote = reportData.slice(64) === nonce;
    const tdAttributes = quote.readBigUInt64LE(48 + 120);
    checks.not_debug_td = (tdAttributes & 1n) === 0n;
    // MRCONFIGID = 0x01 || sha256(app_compose) || zero padding: the enclave runs exactly the published compose.
    const mrConfigId = quote.subarray(48 + 184, 48 + 232).toString("hex");
    const appCompose = m.info?.tcb_info?.app_compose;
    if (appCompose) {
      const composeHash = createHash("sha256").update(appCompose).digest("hex");
      checks.compose_hash_in_mrconfigid = mrConfigId.startsWith("01" + composeHash);
    }
    // Intel's signature chain over the quote, with current collateral (TCB info, CRLs) from a PCCS.
    try {
      const collateral = await js_get_collateral(PCCS, quote);
      const v = js_verify(quote, collateral, BigInt(Math.floor(Date.now() / 1000)));
      checks.intel_signature = true;
      checks.tcb_status = v?.status ?? v?.get?.("status") ?? "verified";
    } catch (e) {
      checks.intel_signature = false;
      checks.intel_error = String(e?.message ?? e).slice(0, 200);
    }
    const ok = Object.entries(checks).every(([k, v]) => typeof v !== "boolean" || v);
    verified.push({ key, model: m.model_name || model, ok, checks });
  }
  const out = { at: new Date().toISOString(), model, nonce, candidates: verified };
  mkdirSync("runs", { recursive: true });
  writeFileSync("runs/attestation.json", JSON.stringify({ ...out, raw: report }, null, 1));
  return out;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("attest.mjs")) {
  const out = await attest();
  for (const c of out.candidates) {
    console.log(`${c.ok ? "VERIFIED" : "REJECTED"} ${c.model} key ${c.key}`);
    for (const [k, v] of Object.entries(c.checks)) console.log(`  ${v === true ? "ok " : v === false ? "NO " : "   "} ${k}${typeof v === "boolean" ? "" : ": " + v}`);
  }
  if (process.argv.includes("--register")) {
    for (const c of out.candidates.filter((c) => c.ok)) {
      await nearCall(cfg.contract, "add_tee_key", { key: c.key });
      console.log("registered on chain:", c.key);
    }
  }
}
