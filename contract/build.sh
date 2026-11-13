#!/usr/bin/env sh
# Build the contract wasm without cargo-near. `--cfg near` is required: without it near-sdk compiles its
# host calls (panic messages, hashing) as local fallbacks and every refusal becomes a bare wasm trap.
set -e
cd "$(dirname "$0")"
RUSTFLAGS="--cfg near -C link-arg=-s" cargo build --target wasm32-unknown-unknown --release
ls -la target/wasm32-unknown-unknown/release/pact.wasm
