//! NEAR AI end-to-end encryption v2, on chain: X25519 ECDH, HKDF-SHA256 (info "ed25519_encryption"),
//! XChaCha20-Poly1305. Wire format: ephemeral_pub(32) || nonce(24) || ciphertext+tag.
//! The contract uses it to decrypt the enclave's signed answer (with the published per-request response key)
//! and to re-encrypt each public message byte for byte, so the referee cannot misreport either.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use curve25519_dalek::edwards::CompressedEdwardsY;
use curve25519_dalek::montgomery::MontgomeryPoint;
use hkdf::Hkdf;
use sha2::Sha256;

fn kdf(shared: &[u8; 32]) -> [u8; 32] {
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared).expand(b"ed25519_encryption", &mut okm).expect("hkdf length");
    okm
}

/// The model's attested ed25519 key, as the X25519 point messages are encrypted to.
pub fn model_x25519(ed25519_pub: &[u8; 32]) -> Result<MontgomeryPoint, String> {
    CompressedEdwardsY(*ed25519_pub)
        .decompress()
        .map(|p| p.to_montgomery())
        .ok_or_else(|| "enclave key is not a valid ed25519 point".to_string())
}

/// Re-encrypt `plaintext` exactly as the referee claims it did (given its ephemeral secret and nonce).
pub fn seal_with(plaintext: &[u8], recipient: &MontgomeryPoint, eph_secret: &[u8; 32], nonce: &[u8; 24]) -> Vec<u8> {
    let eph_pub = MontgomeryPoint::mul_base_clamped(*eph_secret);
    let shared = recipient.mul_clamped(*eph_secret);
    let key = kdf(&shared.to_bytes());
    let ct = XChaCha20Poly1305::new(&key.into()).encrypt(XNonce::from_slice(nonce), plaintext).expect("encrypt");
    let mut wire = Vec::with_capacity(56 + ct.len());
    wire.extend_from_slice(eph_pub.as_bytes());
    wire.extend_from_slice(nonce);
    wire.extend_from_slice(&ct);
    wire
}

/// Decrypt an answer encrypted to the client key whose X25519 secret is `response_key`.
pub fn open(wire: &[u8], response_key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if wire.len() < 56 + 16 {
        return Err("encrypted answer too short".into());
    }
    let eph_pub = MontgomeryPoint(wire[..32].try_into().unwrap());
    let shared = eph_pub.mul_clamped(*response_key);
    let key = kdf(&shared.to_bytes());
    XChaCha20Poly1305::new(&key.into())
        .decrypt(XNonce::from_slice(&wire[32..56]), &wire[56..])
        .map_err(|_| "answer does not decrypt with the published response key".to_string())
}
