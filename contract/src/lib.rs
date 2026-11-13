//! Pact: split-or-steal matches between AI agents whose strategies are sealed inside a NEAR AI TEE.
//!
//! Nobody has to trust the referee. For every answer an agent gives (one talk line, one decision) the
//! referee must hand the contract the enclave's ed25519 signature, the exact request and response bytes
//! it signed, the ephemeral secrets of the public messages and the per-request response key. The contract:
//! 1. verifies the signature with `env::ed25519_verify` against a registered (attested) enclave key;
//! 2. recomputes sha256 of the request and response bytes and matches them to the signed text;
//! 3. rebuilds the public rules and the prompt itself (from a snapshot taken at `open_match`),
//!    re-encrypts them to the enclave key and checks they are byte-identical to what was sent;
//! 4. checks the one message it cannot read is the agent's own sealed strategy (by hash);
//! 5. decrypts the signed answer with the response key and reads the talk line or the move itself;
//! 6. refuses an answer that was already used.
//! The transcript is built by the contract from the verified talk answers, and payouts follow the
//! decrypted moves. If the referee disappears, anyone can refund both stakes after `TIMEOUT_BLOCKS`.

use near_sdk::serde_json::{self, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub mod e2ee;
pub mod sig;
pub mod text;

pub const TIMEOUT_BLOCKS: u64 = 600; // about 10 minutes on testnet
const ELO_K: i64 = 32;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Move {
    Split,
    Steal,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Agent {
    pub id: String,
    pub owner: AccountId,
    pub name: String,
    /// sha256 (hex) of the sealed strategy ciphertext; the strategy itself never touches the chain.
    pub strategy_hash: String,
    pub balance: NearToken,
    pub elo: i64,
    pub played: u32,
    pub splits: u32,
    pub steals: u32,
    pub won: NearToken,
}

/// Ephemeral secret and nonce the referee used to encrypt one public message.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct SealParams {
    pub eph_secret: String,
    pub nonce: String,
}

/// One enclave answer, with everything needed to check it from scratch.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct SignedAnswer {
    pub agent_id: String,
    /// NEAR AI signed text "<model>:<sha256(request)>:<sha256(response)>".
    pub text: String,
    pub signature: String,
    pub tee_key: String,
    pub request_body: String,
    pub response_body: String,
    /// X25519 secret of this request's client key: decrypts the answer, never the strategy.
    pub response_key: String,
    pub rules_seal: SealParams,
    pub prompt_seal: SealParams,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Proof {
    pub agent_id: String,
    /// The talk line or the decision JSON, as decrypted by this contract.
    pub said: String,
    pub text: String,
    pub signature: String,
    pub response_key: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Open,
    Settled,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Match {
    pub id: u64,
    pub a: String,
    pub b: String,
    pub stake: NearToken,
    /// Which agent speaks first, from on-chain randomness.
    pub first: String,
    pub opened_at: u64,
    pub status: Status,
    /// Snapshots at open: what each agent is told about its opponent, and the strategy it must use.
    pub card_a: String,
    pub card_b: String,
    pub strategy_a: String,
    pub strategy_b: String,
    pub name_a: String,
    pub name_b: String,
    /// Built by this contract from the verified talk answers.
    pub transcript: Vec<String>,
    pub moves: Vec<Move>,
    pub reveals: Vec<String>,
    pub proofs: Vec<Proof>,
    pub payout_a: NearToken,
    pub payout_b: NearToken,
    pub to_jackpot: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pact {
    owner: AccountId,
    referee: AccountId,
    model: String,
    tee_keys: IterableSet<String>,
    agents: IterableMap<String, Agent>,
    matches: Vector<Match>,
    used_answers: LookupSet<String>,
    jackpot: NearToken,
}

fn add(a: NearToken, b: NearToken) -> NearToken {
    a.checked_add(b).expect("overflow")
}
fn sub(a: NearToken, b: NearToken) -> NearToken {
    a.checked_sub(b).expect("underflow")
}
fn fail(e: String) -> ! {
    env::panic_str(&e)
}

#[near]
impl Pact {
    #[init]
    pub fn new(owner: AccountId, referee: AccountId, model: String) -> Self {
        Self {
            owner,
            referee,
            model,
            tee_keys: IterableSet::new(b"k"),
            agents: IterableMap::new(b"a"),
            matches: Vector::new(b"m"),
            used_answers: LookupSet::new(b"u"),
            jackpot: NearToken::from_yoctonear(0),
        }
    }

    // ---------- admin ----------

    /// Register an enclave key read from a NEAR AI attestation report whose Intel TDX quote and fresh
    /// nonce were verified off chain (`referee/attest.mjs`; anyone can re-run it).
    pub fn add_tee_key(&mut self, key: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.tee_keys.insert(sig::normalize_key(&key).unwrap_or_else(|e| fail(e)));
    }

    pub fn set_referee(&mut self, referee: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.referee = referee;
    }

    // ---------- players ----------

    /// Create an agent with a sealed strategy. The attached deposit becomes its playing balance.
    #[payable]
    pub fn create_agent(&mut self, id: String, name: String, strategy_hash: String) -> Agent {
        require!(!self.agents.contains_key(&id), "agent id taken");
        require!(id.len() <= 32 && !name.is_empty() && name.chars().count() <= 24, "id or name too long");
        require!(!name.contains('"') && !name.contains('\n'), "name cannot contain quotes or newlines");
        require!(strategy_hash.len() == 64, "strategy_hash must be sha256 hex");
        let agent = Agent {
            id: id.clone(),
            owner: env::predecessor_account_id(),
            name,
            strategy_hash,
            balance: env::attached_deposit(),
            elo: 1000,
            played: 0,
            splits: 0,
            steals: 0,
            won: NearToken::from_yoctonear(0),
        };
        self.agents.insert(id, agent.clone());
        agent
    }

    /// Seal a new strategy (matches already open keep the old one).
    pub fn reseal(&mut self, id: String, strategy_hash: String) {
        let a = self.agents.get_mut(&id).expect("no such agent");
        require!(a.owner == env::predecessor_account_id(), "not your agent");
        require!(strategy_hash.len() == 64, "strategy_hash must be sha256 hex");
        a.strategy_hash = strategy_hash;
    }

    #[payable]
    pub fn top_up(&mut self, id: String) {
        let a = self.agents.get_mut(&id).expect("no such agent");
        a.balance = add(a.balance, env::attached_deposit());
    }

    pub fn withdraw(&mut self, id: String, amount: NearToken) -> Promise {
        let a = self.agents.get_mut(&id).expect("no such agent");
        require!(a.owner == env::predecessor_account_id(), "not your agent");
        require!(a.balance >= amount, "not enough balance");
        a.balance = sub(a.balance, amount);
        Promise::new(a.owner.clone()).transfer(amount)
    }

    // ---------- matches ----------

    /// Referee opens a match: both stakes are locked, each agent's view of its opponent is frozen, and the
    /// speaking order comes from the block's random seed.
    pub fn open_match(&mut self, a: String, b: String, stake: NearToken) -> Match {
        require!(env::predecessor_account_id() == self.referee, "referee only");
        require!(a != b, "an agent cannot play itself");
        let (ag_a, ag_b) = (
            self.agents.get(&a).expect("no such agent").clone(),
            self.agents.get(&b).expect("no such agent").clone(),
        );
        for id in [&a, &b] {
            let ag = self.agents.get_mut(id).unwrap();
            require!(ag.balance >= stake, "agent balance below stake");
            ag.balance = sub(ag.balance, stake);
        }
        let first = if env::random_seed()[0] % 2 == 0 { a.clone() } else { b.clone() };
        let m = Match {
            id: self.matches.len() as u64,
            a,
            b,
            stake,
            first,
            opened_at: env::block_height(),
            status: Status::Open,
            card_a: text::opponent_card(&ag_b.name, ag_b.elo, ag_b.played, ag_b.splits, ag_b.steals),
            card_b: text::opponent_card(&ag_a.name, ag_a.elo, ag_a.played, ag_a.splits, ag_a.steals),
            strategy_a: ag_a.strategy_hash,
            strategy_b: ag_b.strategy_hash,
            name_a: ag_a.name,
            name_b: ag_b.name,
            transcript: vec![],
            moves: vec![],
            reveals: vec![],
            proofs: vec![],
            payout_a: NearToken::from_yoctonear(0),
            payout_b: NearToken::from_yoctonear(0),
            to_jackpot: NearToken::from_yoctonear(0),
        };
        self.matches.push(m.clone());
        m
    }

    /// Referee settles with the two talk answers (in speaking order) and the two decisions.
    /// Every check must pass or nothing moves.
    pub fn settle(&mut self, id: u64, talk: Vec<SignedAnswer>, decisions: Vec<SignedAnswer>) -> Match {
        require!(env::predecessor_account_id() == self.referee, "referee only");
        let m = self.matches.get(id as u32).expect("no such match").clone();
        require!(m.status == Status::Open, "match is not open");
        require!(talk.len() == 2 && decisions.len() == 2, "need two talk answers and two decisions");
        let second = if m.first == m.a { m.b.clone() } else { m.a.clone() };
        require!(talk[0].agent_id == m.first && talk[1].agent_id == second, "talk answers out of speaking order");

        let mut transcript: Vec<String> = vec![];
        let mut proofs = vec![];
        let mut used = vec![];
        for t in &talk {
            let (me, opp, card, strategy) = self.side(&m, &t.agent_id);
            let prompt = text::talk_prompt(card, &transcript, me, opp);
            let (said, resp_hash) = self.check_answer(t, strategy, &prompt).unwrap_or_else(|e| fail(format!("{} talk: {}", t.agent_id, e)));
            let line = format!("{}: {}", me, text::clean_line(&said));
            proofs.push(Proof { agent_id: t.agent_id.clone(), said: line.clone(), text: t.text.clone(), signature: t.signature.clone(), response_key: t.response_key.clone() });
            transcript.push(line);
            used.push(resp_hash);
        }

        let mut moves = [Move::Split; 2];
        let mut reveals = vec![String::new(), String::new()];
        for (i, who) in [m.a.clone(), m.b.clone()].iter().enumerate() {
            let d = decisions.iter().find(|d| &d.agent_id == who).unwrap_or_else(|| fail(format!("decision missing for {}", who)));
            let (me, opp, card, strategy) = self.side(&m, who);
            let prompt = text::decide_prompt(card, &transcript, me, opp);
            let (said, resp_hash) = self.check_answer(d, strategy, &prompt).unwrap_or_else(|e| fail(format!("{} decision: {}", who, e)));
            let (mv, reveal) = text::parse_decision(&said).unwrap_or_else(|| fail(format!("{} decision is not a valid move: {}", who, said)));
            moves[i] = mv;
            reveals[i] = reveal;
            proofs.push(Proof { agent_id: who.clone(), said, text: d.text.clone(), signature: d.signature.clone(), response_key: d.response_key.clone() });
            used.push(resp_hash);
        }
        for h in used {
            require!(!self.used_answers.contains(&h), "an answer was already used in another match");
            self.used_answers.insert(h);
        }

        let pot = add(m.stake, m.stake);
        let zero = NearToken::from_yoctonear(0);
        let (pa, pb, jp) = match (moves[0], moves[1]) {
            (Move::Split, Move::Split) => (m.stake, m.stake, zero),
            (Move::Steal, Move::Split) => (pot, zero, zero),
            (Move::Split, Move::Steal) => (zero, pot, zero),
            (Move::Steal, Move::Steal) => (zero, zero, pot),
        };
        self.jackpot = add(self.jackpot, jp);

        // Elo: an agent "scores" by taking money home; both splitting or both stealing is a draw.
        let (sa, sb) = match (moves[0], moves[1]) {
            (Move::Split, Move::Split) | (Move::Steal, Move::Steal) => (50, 50),
            (Move::Steal, Move::Split) => (100, 0),
            (Move::Split, Move::Steal) => (0, 100),
        };
        let ea = self.agents.get(&m.a).unwrap().elo;
        let eb = self.agents.get(&m.b).unwrap().elo;
        let (da, db) = elo_delta(ea, eb, sa, sb);
        for (who, pay, mv, d) in [(&m.a, pa, moves[0], da), (&m.b, pb, moves[1], db)] {
            let ag = self.agents.get_mut(who).unwrap();
            ag.balance = add(ag.balance, pay);
            if pay > m.stake {
                ag.won = add(ag.won, sub(pay, m.stake));
            }
            ag.played += 1;
            match mv {
                Move::Split => ag.splits += 1,
                Move::Steal => ag.steals += 1,
            }
            ag.elo += d;
        }

        let stored = self.matches.get_mut(id as u32).unwrap();
        stored.status = Status::Settled;
        stored.transcript = transcript;
        stored.moves = moves.to_vec();
        stored.reveals = reveals;
        stored.proofs = proofs;
        stored.payout_a = pa;
        stored.payout_b = pb;
        stored.to_jackpot = jp;
        stored.clone()
    }

    /// Anyone can refund an open match whose referee went silent.
    pub fn refund_stale(&mut self, id: u64) -> Match {
        let m = self.matches.get(id as u32).expect("no such match").clone();
        require!(m.status == Status::Open, "match is not open");
        require!(env::block_height() >= m.opened_at + TIMEOUT_BLOCKS, "match is not stale yet");
        for who in [&m.a, &m.b] {
            let ag = self.agents.get_mut(who).unwrap();
            ag.balance = add(ag.balance, m.stake);
        }
        let stored = self.matches.get_mut(id as u32).unwrap();
        stored.status = Status::Refunded;
        stored.clone()
    }

    // ---------- views ----------

    pub fn get_agent(&self, id: String) -> Option<Agent> {
        self.agents.get(&id).cloned()
    }

    pub fn agents(&self, from: u32, limit: u32) -> Vec<Agent> {
        self.agents.values().skip(from as usize).take(limit as usize).cloned().collect()
    }

    pub fn get_match(&self, id: u64) -> Option<Match> {
        self.matches.get(id as u32).cloned()
    }

    /// Newest first.
    pub fn recent_matches(&self, limit: u32) -> Vec<Match> {
        let n = self.matches.len();
        (0..n.min(limit)).map(|i| self.matches.get(n - 1 - i).unwrap().clone()).collect()
    }

    pub fn info(&self) -> (AccountId, AccountId, String, Vec<String>, NearToken, u32) {
        (self.owner.clone(), self.referee.clone(), self.model.clone(), self.tee_keys.iter().cloned().collect(), self.jackpot, self.matches.len())
    }

    /// The exact public text every agent receives, so anyone (and the referee) can rebuild requests.
    pub fn rules(&self) -> String {
        text::RULES.to_string()
    }

    /// Pure check, for anyone: does this signed text verify against a registered enclave key?
    pub fn verify_signed(&self, text: String, signature: String, tee_key: String) -> String {
        let key = match sig::normalize_key(&tee_key) {
            Ok(k) => k,
            Err(e) => return e,
        };
        if !self.tee_keys.contains(&key) {
            return "not a registered enclave key".into();
        }
        match sig::verify_ed25519(&text, &signature, &key) {
            Ok(()) => "ok".into(),
            Err(e) => e,
        }
    }
}

impl Pact {
    /// (my name, opponent name, my card, my strategy hash) for an agent in a match.
    fn side<'a>(&self, m: &'a Match, who: &str) -> (&'a str, &'a str, &'a str, &'a str) {
        if who == m.a {
            (&m.name_a, &m.name_b, &m.card_a, &m.strategy_a)
        } else if who == m.b {
            (&m.name_b, &m.name_a, &m.card_b, &m.strategy_b)
        } else {
            fail(format!("{} is not in this match", who))
        }
    }

    /// Verify one enclave answer end to end; returns the decrypted answer and the response hash.
    fn check_answer(&self, a: &SignedAnswer, strategy_hash: &str, prompt: &str) -> Result<(String, String), String> {
        let key_hex = sig::normalize_key(&a.tee_key)?;
        if !self.tee_keys.contains(&key_hex) {
            return Err("signed by a key that is not a registered enclave key".into());
        }
        let parsed = sig::parse_text(&a.text)?;
        if parsed.model != self.model {
            return Err("signed by a different model".into());
        }
        sig::verify_ed25519(&a.text, &a.signature, &key_hex)?;
        if sig::sha256_hex(a.request_body.as_bytes()) != parsed.request_hash.to_ascii_lowercase() {
            return Err("request bytes do not match the signed hash".into());
        }
        if sig::sha256_hex(a.response_body.as_bytes()) != parsed.response_hash.to_ascii_lowercase() {
            return Err("response bytes do not match the signed hash (edited after signing)".into());
        }

        let req: Value = serde_json::from_str(&a.request_body).map_err(|_| "request is not JSON")?;
        if req["model"].as_str() != Some(self.model.as_str()) {
            return Err("request names a different model".into());
        }
        let msgs = req["messages"].as_array().ok_or("request has no messages")?;
        if msgs.len() != 3 {
            return Err("request must hold exactly rules, sealed strategy, prompt".into());
        }
        let content = |i: usize| msgs[i]["content"].as_str().ok_or_else(|| format!("message {} has no content", i));
        if sig::sha256_hex(content(1)?.as_bytes()) != strategy_hash {
            return Err("the sealed message is not this agent's strategy".into());
        }

        let pk: [u8; 32] = sig::hex_decode(&key_hex)?.try_into().map_err(|_| "key length")?;
        let recipient = e2ee::model_x25519(&pk)?;
        for (i, plain, seal) in [(0usize, text::RULES, &a.rules_seal), (2usize, prompt, &a.prompt_seal)] {
            let eph: [u8; 32] = sig::hex_decode(&seal.eph_secret)?.try_into().map_err(|_| "eph secret length")?;
            let nonce: [u8; 24] = sig::hex_decode(&seal.nonce)?.try_into().map_err(|_| "nonce length")?;
            let expect = sig::hex_encode(&e2ee::seal_with(plain.as_bytes(), &recipient, &eph, &nonce));
            if expect != content(i)?.to_ascii_lowercase() {
                return Err(format!("public message {} is not the text this contract expects", i));
            }
        }

        let resp: Value = serde_json::from_str(&a.response_body).map_err(|_| "response is not JSON")?;
        let wire_hex = resp["choices"][0]["message"]["content"].as_str().ok_or("response has no content")?;
        let rk: [u8; 32] = sig::hex_decode(&a.response_key)?.try_into().map_err(|_| "response key length")?;
        let said = String::from_utf8(e2ee::open(&sig::hex_decode(wire_hex)?, &rk)?).map_err(|_| "answer is not UTF-8")?;
        Ok((said, parsed.response_hash.to_ascii_lowercase()))
    }
}

/// Integer Elo with a linear approximation of the logistic curve (no floats in contracts).
fn elo_delta(ea: i64, eb: i64, score_a: i64, score_b: i64) -> (i64, i64) {
    let diff = (eb - ea).clamp(-800, 800);
    let exp_a = 50 - diff * 45 / 800; // 5%..95%
    let exp_b = 100 - exp_a;
    (ELO_K * (score_a - exp_a) / 100, ELO_K * (score_b - exp_b) / 100)
}

#[cfg(test)]
mod tests;
