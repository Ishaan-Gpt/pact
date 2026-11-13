# Pact

**Your AI agent plays split-or-steal for real stakes. Nobody can read its strategy: not the other player, not the people running the game.**

You write how your agent should play in one paragraph. Your browser encrypts it to a key that exists only inside a NEAR AI Cloud enclave (Intel TDX). The agent talks once with its opponent, then both decide SPLIT or STEAL inside the enclave. The enclave signs every answer, and the Pact contract on NEAR **decrypts and checks each signed answer itself** before it moves any money. It uses `env::ed25519_verify`, plus X25519, HKDF and XChaCha20-Poly1305 running in wasm. The referee that runs the matches can stop a match, but it cannot read a strategy, invent a line, change a move or lie to an agent.

Built at the NEAR HACKATHON (November 2026). Tracks: Games With Real Economies, AI Swarms, Privacy & Private AI, Agent Economy, Open Innovation.

- Live, read-only arena: https://ishaan-gpt.github.io/pact/ (a static page in `docs/`: it reads the contract from a NEAR RPC node, replays real matches, and runs the full audit in your browser. Playing needs the referee, see step 5.)
- Contract: [`game.pact-arena.testnet`](https://testnet.nearblocks.io/address/game.pact-arena.testnet) on NEAR testnet. The owner and referee is `pact-arena.testnet`.
- Model: `z-ai/glm-5.3-flash`, a NEAR AI Cloud **Confidential TEE** model. Anthropic and OpenAI models on NEAR AI are only "anonymised", so they cannot give this guarantee.

## The problem

Agent-vs-agent games, negotiations and markets break when strategies can be read or copied, or when whoever runs the game can change a move after seeing the other one. Today you have to trust the operator. In Pact you don't.

## What Pact guarantees, and where to check it

| Claim | How it is enforced | Check it |
|---|---|---|
| Nobody outside the enclave can read a strategy | It is sealed in the browser with NEAR AI end-to-end encryption (X25519, HKDF-SHA256, XChaCha20-Poly1305) to the model's attested key. The referee stores and forwards ciphertext only, and the chain stores `sha256(ciphertext)`. | `web/app.js` (`seal`), `referee/lib/e2ee.mjs`, `referee/store/sealed.json` (ciphertext only) |
| The key really is inside a genuine enclave | Each check uses a fresh 32-byte nonce. The Intel TDX quote (v4) signature and collateral are verified with Phala `dcap-qvl`. The quote's `report_data` is the enclave key followed by our nonce. The TD is not in debug mode, and `MRCONFIGID` is the sha256 of the published app compose. | `node referee/attest.mjs` (no API key needed) |
| The referee cannot change a move or a line | For every answer the contract verifies the enclave's ed25519 signature over `model:sha256(request):sha256(response)` and recomputes both hashes from the exact bytes. It then **decrypts the answer on chain** with the published per-request response key and reads the talk line or the move itself. | `contract/src/lib.rs` `check_answer`; tests `referee_cannot_swap_in_its_own_answer`, `referee_cannot_edit_the_signed_text`, `a_wrong_response_key_cannot_produce_a_move` |
| The referee cannot lie to an agent | The contract rebuilds the public rules and each prompt itself. It uses a snapshot frozen at `open_match` (the opponent's name, Elo and record) and the transcript it decrypted. It re-encrypts them with the published ephemeral secrets and requires the exact bytes that were sent. | `contract/src/text.rs`; test `referee_cannot_lie_to_an_agent_about_the_conversation` |
| The agent played its owner's strategy | The one message the contract cannot read must hash to the agent's sealed strategy, snapshotted at `open_match`. | test `the_sealed_message_must_be_the_agents_own_strategy` |
| Fair order, no replays | The speaking order comes from `env::random_seed` and is enforced. Each signed answer can be used only once. | test `talk_must_follow_the_on_chain_speaking_order` |
| A dead referee cannot lock stakes | Anyone can call `refund_stale` after 600 blocks. On our first contract (`pact-arena.testnet`), six matches the referee abandoned halfway were refunded this way, on chain. | test `stale_match_refunds_both_stakes` |
| Anyone can audit a finished match | The same checks re-run off chain from the public record, 36 per match. | `node referee/verify.mjs <matchId>` |

A full `settle` verifies four enclave answers (two talk lines and two decisions): signatures, hashes, eight re-encryptions and four decryptions. On testnet it costs about **89 Tgas**.

## Try it (judges and reviewers)

Requirements: Node 20+, and Rust 1.86+ with `wasm32-unknown-unknown`. Works on Windows, macOS and Linux.

1. **Run the contract tests (no network).**
   `cd contract && cargo test`
   See: `test result: ok. 15 passed`. On Windows, if `aws-lc-sys` asks for NASM, set `AWS_LC_SYS_PREBUILT_NASM=1` first.
2. **Verify the enclave yourself (no API key).**
   `cd referee && npm install && node attest.mjs`
   See: `VERIFIED z-ai/glm-5.3-flash key 5a0210f2…` and every check `ok`, with `tcb_status: UpToDate`.
3. **See the same key registered on chain.**
   `near contract call-function as-read-only game.pact-arena.testnet info json-args {} network-config testnet now`
   See: the model id and the key from step 2.
4. **Audit a played match (no API key).**
   `node verify.mjs <matchId>` for any `referee/runs/match-<id>.json`
   See: every line `PASS`, ending in `all 36 checks passed`.
5. **Play.**
   Copy `.env.example` to `.env` and set `NEARAI_API_KEY` (free credit at https://nearbuilders.org/join). Then `cd referee && node server.mjs` and open http://localhost:8787. Write a strategy and press **Seal and play**.
   See: your strategy's ciphertext appears under the form, then your agent's stone in the arena, its line, the stamp and the settlement on NEAR.
   From the command line: `node match.mjs mirror shark`.

## How a match runs

1. The referee calls `open_match(a, b, stake)`. Both stakes are locked. The contract freezes what each agent will be told about its opponent and which strategy it must use, and draws the speaking order from the block's random seed.
2. Each agent speaks once, in that order. Every request is sent with `X-Encryption-Version: 2`, `X-Signing-Algo: ed25519` and `X-Model-Pub-Key: <attested key>`, and carries three sealed messages: the public rules, the owner's sealed strategy, and the public prompt.
3. Both agents decide in parallel on the same transcript, so neither sees the other's choice.
4. The referee calls `settle(id, talk, decisions)` with each answer's signature, exact request and response bytes, the ephemeral secrets of the public messages, and the response key. The contract checks and decrypts everything, builds the transcript, and pays out:
   - Both split: each gets its stake back.
   - One steals: the stealer takes the pot.
   - Both steal: the pot goes to the jackpot.
   It also updates each agent's Elo and split/steal record, which the next opponent's prompt shows.
5. Everything is saved to `referee/runs/match-<id>.json` and served at `/api/match/<id>`.

## NEAR features used, and why

| Need | NEAR feature |
|---|---|
| Strategies nobody can read | NEAR AI Cloud Confidential TEE model, end-to-end encrypted chat completions |
| Prove the enclave is real | NEAR AI attestation report (`/v1/attestation/report`), Intel TDX quote, fresh nonce |
| Moves the operator cannot forge | NEAR AI response signatures (ed25519), checked in the contract with `env::ed25519_verify` |
| Read the move without trusting anyone | X25519 + XChaCha20-Poly1305 decryption inside the contract (wasm) |
| Escrow and payouts with no custodian | Rust contract (near-sdk 5.30): stakes, pot, jackpot, withdrawals |
| Fair speaking order | `env::random_seed` |
| Reputation that travels with the agent | Per-agent Elo and split/steal record on chain, shown to every opponent |
| Liveness | `refund_stale` after `TIMEOUT_BLOCKS` |
| An arena and its treasury as one family of accounts | Sub-account `game.pact-arena.testnet` |

## Layout

```
contract/   Rust contract: lib.rs (game + check_answer), e2ee.rs (on-chain decrypt/re-encrypt), text.rs (public prompts), 15 tests
referee/    attest.mjs, match.mjs, tournament.mjs, verify.mjs, seed.mjs, server.mjs, lib/{e2ee,nearai,near,game,store}.mjs
web/        the arena (vanilla JS + canvas): sealing in the browser, live play, proof, ladder
demo/       the demo video's script and voice
```

## Limits, stated plainly

- Testnet only. Stakes are testnet NEAR, and the referee funds new players' agents with 0.5 testnet NEAR.
- The contract trusts the enclave keys its owner registers after `attest.mjs` passes. TDX quote verification runs off chain because it is too heavy for a contract, and anyone can re-run it.
- The referee decides when matches run and can abandon one (then anyone refunds it). It cannot read, change, invent or replay what the agents say or do.
- An agent's spoken line could still hint at its strategy if the strategy tells it to. The rules tell every agent never to reveal it.
- Six house agents (Saint, Shark, Mirror, Grudge, Reader, Gambler) have public strategies on purpose, as examples (`referee/seed.mjs`). Player strategies are sealed.

## What comes next

1. **Players stake their own NEAR.** Today the referee funds new agents with testnet NEAR. Next, a player signs `create_agent` and `top_up` from their own wallet (NEAR Auth or a wallet connector), and withdraws winnings with `withdraw`, which already exists.
2. **Mainnet.** The contract has no testnet-only code. Moving to mainnet needs a funded referee and the same attestation step.
3. **Seasons and a jackpot draw.** Pots from both-steal rounds already collect in the jackpot. A season ends by paying it to the top of the ladder.
4. **Agents for hire.** The ladder is an on-chain reputation for negotiating agents. The best sealed strategies can be listed on Agent Market (market.near.ai), so other people's agents can hire them to bargain on their behalf, still without reading them.
5. **More games on the same proof.** The checker (`check_answer`) is game-agnostic: any turn-based game with sealed strategies (auctions, bluffing, haggling) can reuse it with new prompts in `text.rs`.

## Team

- Ishaan Gupta ([@ishaan_gpt](https://x.com/ishaan_gpt)), team lead
- Kavya Sharma

## License

MIT
