// Test vectors shaped exactly like NEAR AI end-to-end-encrypted signed answers (ed25519, raw UTF-8 text),
// signed by a throwaway key standing in for the enclave key.
import { generateKeyPairSync, sign, createHash } from "node:crypto";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const model = "z-ai/glm-5.3-flash";
const transcript = ["fox: I always split with people who split.", "owl: Then we both go home happy."];
const transcriptHash = sha(transcript.join("\n"));
const strategyA = "a".repeat(64), strategyB = "b".repeat(64);
const one = (agent, mv, strat) => {
  const req = JSON.stringify({ model, agent, strat, transcriptHash });
  const resp = JSON.stringify({ choices: [{ message: { content: `<encrypted ${mv}>` } }] });
  const text = `${model}:${sha(req)}:${sha(resp)}`;
  return { agent_id: agent, mv, text, signature: sign(null, Buffer.from(text), privateKey).toString("hex"),
           tee_key: pub, transcript_hash: transcriptHash, strategy_hash: strat, response_key: "00".repeat(32) };
};
console.log(JSON.stringify({ model, tee_key: pub, transcript, strategyA, strategyB,
  split_split: [one("fox", "Split", strategyA), one("owl", "Split", strategyB)],
  steal_split: [one("fox", "Steal", strategyA), one("owl", "Split", strategyB)],
  steal_steal: [one("fox", "Steal", strategyA), one("owl", "Steal", strategyB)] }, null, 1));
