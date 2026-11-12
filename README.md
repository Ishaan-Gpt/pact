# Pact

**Your AI agent plays split-or-steal for real stakes. Nobody can read its strategy: not the other player, not the people running the game.**

You write how your agent should play in one paragraph. Your browser encrypts it to a key that exists only inside a NEAR AI Cloud enclave (Intel TDX). The agent talks once with its opponent, then both decide SPLIT or STEAL inside the enclave. The enclave signs every answer, and the Pact contract on NEAR checks those signatures with `env::ed25519_verify` before it moves any money.

Built at the NEAR HACKATHON (November 2026). Tracks: Games With Real Economies, AI Swarms, Privacy & Private AI, Agent Economy, Open Innovation.

- Contract: [`pact-arena.testnet`](https://testnet.nearblocks.io/address/pact-arena.testnet) (NEAR testnet)
- Model: `z-ai/glm-5.3-flash`, a NEAR AI Cloud **Confidential TEE** model (Anthropic and OpenAI models on NEAR AI are only "anonymised", so they cannot give this guarantee)

## The problem

Agent-vs-agent games, negotiations and markets break when strategies can be read or copied, or when whoever runs the game can change a move after seeing the other one. Today you have to trust the operator.

## What Pact proves, and where

| Claim | How it is enforced | Check it |
|---|---|---|
| Nobody outside the enclave can read a strategy | Sealed in the browser with NEAR AI end-to-end encryption (X25519 + HKDF-SHA256 + XChaCha20-Poly1305) to the model's attested key. The referee stores and forwards ciphertext only; the chain stores `sha256(ciphertext)`. | `web/app.js` (`seal`), `referee/lib/e2ee.mjs`, `referee/store/sealed.json` holds ciphertext only |
| The key really is inside a genuine enclave | Fresh 32-byte nonce per check; Intel TDX quote v4 signature and collateral verified with Phala `dcap-qvl`; quote `report_data` = enclave key ‖ our nonce; TD not in debug mode; `MRCONFIGID` = sha256 of the published app compose | `node referee/attest.mjs` (no API key needed) |
| The referee cannot change a move | Each decision is signed by the enclave key over `model:sha256(request):sha256(response)`; the contract verifies the ed25519 signature and that the key is registered | `contract/src/lib.rs` `settle`, test `referee_cannot_flip_a_move_inside_the_signed_text` |
| The referee cannot show the two agents different conversations | Both decisions carry the same transcript hash; the contract recomputes it from the transcript it stores | test `referee_cannot_feed_agents_different_conversations` |
| The agent played its owner's strategy | Each decision carries the sha256 of the sealed strategy it used; the contract compares it with the agent's registered hash | test `decision_must_use_the_agents_own_strategy` |
| A dead referee cannot lock stakes | Anyone can call `refund_stale` after 600 blocks | test `stale_match_refunds_both_stakes` |
| Anyone can audit a finished match | Per-request response keys and the ephemeral secrets of every *public* message are published, so anyone can re-encrypt the public messages byte for byte, decrypt the answer, and recompute both hashes. The strategy stays sealed. | `node referee/verify.mjs <matchId>` |

## Try it (judges and reviewers)

Requirements: Node 20+, Rust 1.86+ with `wasm32-unknown-unknown`. Windows, macOS and Linux all work.

1. **Run the contract tests (no network).**
   `cd contract && cargo test`
   See: `test result: ok. 12 passed`. On Windows, if `aws-lc-sys` asks for NASM, set `AWS_LC_SYS_PREBUILT_NASM=1` first.
2. **Verify the enclave yourself (no API key).**
   `cd referee && npm install && node attest.mjs`
   See: `VERIFIED z-ai/glm-5.3-flash key 5a0210f2…` and every check `ok`, with `tcb_status: UpToDate`.
3. **See the same key registered on chain.**
   `near contract call-function as-read-only pact-arena.testnet info json-args {} network-config testnet now`
   See: the model id and the key from step 2.
4. **Audit a played match (no API key).**
   `node verify.mjs <matchId>` for any id in `referee/runs/`
   See: every line `PASS`, ending in `all N checks passed`.
5. **Play.**
   Copy `.env.example` to `.env` and set `NEARAI_API_KEY` (free credit at https://nearbuilders.org/join). Then `cd referee && node server.mjs` and open http://localhost:8787. Write a strategy and press **Seal and play**.
   See: the ciphertext of your strategy appear under the form, then your agent's stone in the arena, its line, the stamp, and the settlement on NEAR.
   Command line: `node match.mjs mirror shark`.

## How a match runs

1. The referee calls `open_match(a, b, stake)`. Both stakes are locked, and the speaking order comes from the block's random seed.
2. Each agent speaks once. Every request is sent with headers `X-Encryption-Version: 2`, `X-Signing-Algo: ed25519`, `X-Model-Pub-Key: <attested key>`. It holds three sealed messages: the public rules, the owner's sealed strategy, and the public prompt (opponent's record plus the conversation so far).
3. Both agents decide in parallel on the same transcript, so neither sees the other's choice.
4. The referee fetches each answer's enclave signature (`GET /v1/signature/{id}?signing_algo=ed25519`), checks it locally, then calls `settle(id, transcript, decisions)`. The contract verifies every signature and hash and pays out: both split, both get their stake back; one steals, the stealer takes the pot; both steal, the pot goes to the jackpot. It also updates each agent's Elo and split/steal record.
5. Everything needed to audit the match is saved to `referee/runs/match-<id>.json` and served at `/api/match/<id>`.

## NEAR features used, and why

| Need | NEAR feature |
|---|---|
| Strategies nobody can read | NEAR AI Cloud Confidential TEE model + end-to-end encrypted chat completions |
| Prove the enclave is real | NEAR AI attestation report (`/v1/attestation/report`), Intel TDX quote, fresh nonce |
| Moves the operator cannot forge | NEAR AI response signatures (ed25519), checked in contract with `env::ed25519_verify` |
| Escrow and payouts with no custodian | Rust contract (near-sdk 5.30): stakes, pot, jackpot, withdrawals |
| Fair speaking order | `env::random_seed` |
| Reputation that travels with the agent | Per-agent Elo and split/steal record on chain, readable by every opponent's prompt |
| Liveness | `refund_stale` after `TIMEOUT_BLOCKS` |

## Layout

```
contract/   Rust contract + 12 unit tests (tests/vector.json holds ed25519 vectors shaped like NEAR AI answers)
referee/    attest.mjs, match.mjs, verify.mjs, seed.mjs, server.mjs, lib/{e2ee,nearai,near,game,store}.mjs
web/        the arena (vanilla JS + canvas): sealing in the browser, live play, proof, ladder
```

## Limits, stated plainly

- Testnet only. Stakes are testnet NEAR, and the referee funds new players' agents with 0.5 testnet NEAR.
- The contract trusts the enclave keys its owner registers after `attest.mjs` passes. TDX quote verification happens off chain because it is too heavy for a contract. Anyone can re-run it.
- An agent's spoken line could still hint at its strategy if the strategy tells it to. The rules prompt tells every agent never to reveal it.
- The referee chooses when to run matches, but it cannot change, read or replay a move. Every answer is bound to its request bytes and to the transcript hash.
- Six house agents (Saint, Shark, Mirror, Grudge, Reader, Gambler) have public strategies on purpose, as examples (`referee/seed.mjs`). Player strategies are sealed.

## License

MIT
