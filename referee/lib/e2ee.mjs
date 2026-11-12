// NEAR AI end-to-end encryption, protocol v2 (X25519 ECDH, HKDF-SHA256 info "ed25519_encryption",
// XChaCha20-Poly1305). Wire format: ephemeral_pub(32) || nonce(24) || ciphertext+tag.
// Pure JS (noble), so the exact same file seals strategies in the browser.
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes, bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const INFO = utf8ToBytes("ed25519_encryption");
const kdf = (shared) => hkdf(sha256, shared, undefined, INFO, 32);

/** Encrypt to the model's attested ed25519 key. Returns wire hex plus the ephemeral secret and nonce,
 *  which the referee publishes for public (non-strategy) messages so anyone can re-encrypt and compare. */
export function seal(plaintext, modelEd25519PubHex, { ephSecret, nonce } = {}) {
  const recipient = ed25519.utils.toMontgomery(hexToBytes(modelEd25519PubHex));
  const eph = ephSecret ? hexToBytes(ephSecret) : x25519.utils.randomSecretKey();
  const n = nonce ? hexToBytes(nonce) : randomBytes(24);
  const key = kdf(x25519.getSharedSecret(eph, recipient));
  const ct = xchacha20poly1305(key, n).encrypt(utf8ToBytes(plaintext));
  const wire = new Uint8Array(32 + 24 + ct.length);
  wire.set(x25519.getPublicKey(eph), 0);
  wire.set(n, 32);
  wire.set(ct, 56);
  return { wire: bytesToHex(wire), ephSecret: bytesToHex(eph), nonce: bytesToHex(n) };
}

/** A per-request client key pair. The ed25519 public key goes in X-Client-Pub-Key; the response is
 *  encrypted to its X25519 form, so `responseKey` (the X25519 secret) decrypts only the answer. */
export function clientKey() {
  const sk = ed25519.utils.randomSecretKey();
  return { pubHex: bytesToHex(ed25519.getPublicKey(sk)), responseKey: bytesToHex(ed25519.utils.toMontgomerySecret(sk)) };
}

export function open(wireHex, responseKeyHex) {
  const w = hexToBytes(wireHex);
  const key = kdf(x25519.getSharedSecret(hexToBytes(responseKeyHex), w.subarray(0, 32)));
  return new TextDecoder().decode(xchacha20poly1305(key, w.subarray(32, 56)).decrypt(w.subarray(56)));
}

export const sha256Hex = (data) => bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
export { bytesToHex, hexToBytes };
