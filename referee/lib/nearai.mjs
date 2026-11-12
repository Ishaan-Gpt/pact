// NEAR AI Cloud client: end-to-end encrypted chat completions plus the enclave's signature for each.
import { cfg } from "./near.mjs";
import { clientKey, open, sha256Hex } from "./e2ee.mjs";

const BASE = "https://cloud-api.near.ai";

/** messages: [{ role, content }] where every content is already sealed wire hex.
 *  Returns the decrypted answer plus everything needed to prove it on chain and to anyone. */
export async function sealedChat({ messages, modelKey, model = cfg.model, maxTokens = 400 }) {
  if (!cfg.apiKey) throw new Error("NEARAI_API_KEY missing in .env");
  const ck = clientKey();
  const body = JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, temperature: 0.7 });
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      "accept-encoding": "identity",
      "x-signing-algo": "ed25519",
      "x-client-pub-key": ck.pubHex,
      "x-model-pub-key": modelKey,
      "x-encryption-version": "2",
      "x-no-aliasing": "true",
    },
    body,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`chat ${res.status}: ${raw.slice(0, 400)}`);
  const json = JSON.parse(raw);
  const msg = json.choices?.[0]?.message ?? {};
  const content = msg.content ? open(msg.content, ck.responseKey) : "";
  const sig = await signatureFor(json.id, model);
  const requestHash = sha256Hex(body);
  const responseHash = sha256Hex(raw);
  const [sModel, sReq, sResp] = splitText(sig.text);
  return {
    content,
    chatId: json.id,
    requestBody: body,
    responseBody: raw,
    responseKey: ck.responseKey,
    signature: sig,
    // Local checks before anything goes on chain.
    checks: {
      signed_by_model_tee: sig.signature_kind !== "gateway" && sModel === model,
      request_hash_matches: sReq === requestHash,
      response_hash_matches: sResp === responseHash,
      signer_is_attested_key: sig.signing_address?.toLowerCase() === modelKey.toLowerCase(),
    },
  };
}

function splitText(t) {
  const p = t.split(":");
  return p.length >= 3 ? [p.slice(0, -2).join(":"), p.at(-2), p.at(-1)] : [null, p[0], p[1]];
}

async function signatureFor(chatId, model) {
  const url = `${BASE}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ed25519`;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      if (j.signature && j.text) return j;
    }
    await new Promise((s) => setTimeout(s, 500 * (i + 1)));
  }
  throw new Error(`no signature for ${chatId}`);
}
