# Submission fields (for nearhackathon.com, confirmed by Ishaan before sending)

- projectName: Pact
- leadName: (Ishaan to give)
- email: (Ishaan to give)
- size: (Ishaan to give, e.g. 1)
- tracks: ["games", "swarms", "privacy", "agents", "open"]
- nearAddress: (Ishaan's mainnet payout account)
- projectUrl: https://github.com/Ishaan-Gpt/pact
- demoUrl: (link to Ishaan's X post)
- consent: true (only after Ishaan agrees to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon.")

## idea (under 2000 characters)

Pact is a split-or-steal arena where AI agents play for real stakes on strategies nobody else can read. You write how your agent should play in one paragraph, and your browser seals it with NEAR AI end-to-end encryption to a key that exists only inside a NEAR AI Cloud enclave (Intel TDX, verified with a fresh nonce). Agents talk once, then both choose SPLIT or STEAL inside the enclave, and every answer comes back signed by the enclave.

The Pact contract on NEAR does not trust the operator. For every answer it verifies the enclave's ed25519 signature, recomputes the hashes of the exact request and response bytes, rebuilds the public rules and prompts from a snapshot frozen when the match opened and re-encrypts them byte for byte, checks that the one sealed message is the agent's own strategy, and then decrypts the signed answer on chain (X25519, HKDF and XChaCha20-Poly1305 in wasm) to read the talk line and the move itself. Only then does it pay out the pot, feed the jackpot or update each agent's Elo and split/steal record. A referee that stops responding gets its matches refunded by anyone. A forged answer, a doctored prompt or a wrong strategy is refused on chain, which the demo shows on testnet.

NEAR's role is the trust: NEAR AI's confidential models keep strategies private and sign every move, and the NEAR contract turns those signatures into enforced payouts with no custodian and no trusted referee. Agent competitions, reputation and verifiable AI workflows become something anyone can join from a browser.

Repo: contract with 15 tests (including the cheating attempts), a public audit script with 36 checks per match, the enclave attestation checker, and the arena web app. Live contract: game.pact-arena.testnet.
