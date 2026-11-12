//! Checks for NEAR AI Cloud signed answers.
//!
//! In end-to-end encrypted mode NEAR AI signs with an ed25519 key generated inside the model TEE.
//! The signed text is `<model>:<sha256(request body)>:<sha256(response body)>` over the raw bytes,
//! signed as plain UTF-8 (no prefix). NEAR verifies ed25519 natively with `env::ed25519_verify`.

use near_sdk::env;

pub fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim().trim_start_matches("0x");
    if s.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "bad hex".to_string()))
        .collect()
}

pub fn hex_encode(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn normalize_key(k: &str) -> Result<String, String> {
    let b = hex_decode(k)?;
    if b.len() != 32 {
        return Err("ed25519 public key must be 32 bytes".into());
    }
    Ok(hex_encode(&b))
}

/// The three parts of a NEAR AI signed text.
pub struct SignedText<'a> {
    pub model: &'a str,
    pub request_hash: &'a str,
    pub response_hash: &'a str,
}

pub fn parse_text(text: &str) -> Result<SignedText<'_>, String> {
    // model ids contain '/', never ':'; split from the right to be safe.
    let mut it = text.rsplitn(3, ':');
    let response_hash = it.next().ok_or("no response hash")?;
    let request_hash = it.next().ok_or("no request hash")?;
    let model = it.next().ok_or("no model id (gateway signature, not a model TEE signature)")?;
    for h in [request_hash, response_hash] {
        if h.len() != 64 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("hash is not 32 bytes of hex".into());
        }
    }
    Ok(SignedText { model, request_hash, response_hash })
}

/// Verify an ed25519 signature over `text` by `pubkey_hex`.
pub fn verify_ed25519(text: &str, signature_hex: &str, pubkey_hex: &str) -> Result<(), String> {
    let sig: [u8; 64] = hex_decode(signature_hex)?
        .try_into()
        .map_err(|_| "signature must be 64 bytes".to_string())?;
    let pk: [u8; 32] = hex_decode(pubkey_hex)?
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    if env::ed25519_verify(&sig, text.as_bytes(), &pk) {
        Ok(())
    } else {
        Err("signature does not verify (text or move was edited after signing)".into())
    }
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex_encode(&env::sha256(b))
}
