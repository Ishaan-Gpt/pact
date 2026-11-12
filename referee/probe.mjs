// One sealed NEAR AI call: proves E2EE + enclave signature end to end before any match.
import { ed25519 } from "@noble/curves/ed25519.js";
import { nearView } from "./lib/near.mjs";
import { seal, hexToBytes } from "./lib/e2ee.mjs";
import { sealedChat } from "./lib/nearai.mjs";
const key = (await nearView("info"))[3].at(-1);
const r = await sealedChat({ modelKey: key, maxTokens: 120, messages: [
  { role: "system", content: seal("Answer in one short line.", key).wire },
  { role: "user", content: seal("Say SPLIT or STEAL and one reason.", key).wire } ] });
console.log("answer:", r.content);
console.log("signature kind:", r.signature.signature_kind, "algo:", r.signature.signing_algo);
console.log("signed text:", r.signature.text);
console.log("checks:", r.checks);
console.log("ed25519 verifies locally:", ed25519.verify(hexToBytes(r.signature.signature.replace(/^0x/, "")), new TextEncoder().encode(r.signature.text), hexToBytes(key)));
const v = await nearView("verify_signed", { text: r.signature.text, signature: r.signature.signature.replace(/^0x/, ""), tee_key: key });
console.log("contract verify_signed:", v);
