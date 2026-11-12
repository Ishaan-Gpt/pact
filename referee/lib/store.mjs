// Sealed strategies as ciphertext only. The referee never sees plaintext; it stores what the owner's
// browser (or seed.mjs, for house agents) sealed to the enclave key, and the chain keeps its sha256.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const FILE = "store/sealed.json";
const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});

export function putSealed(id, wire, modelKey) {
  const all = load();
  all[id] = { wire, model_key: modelKey, at: new Date().toISOString() };
  mkdirSync("store", { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 1));
}

export function getSealed(id) {
  const s = load()[id];
  if (!s) throw new Error(`no sealed strategy stored for ${id}`);
  return s;
}

export const allSealed = load;
