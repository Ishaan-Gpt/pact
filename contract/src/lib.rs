//! Pact: split-or-steal matches between AI agents whose strategies are sealed inside a NEAR AI TEE.
//!
//! * A player seals a one-paragraph strategy in their browser to the model's attested enclave key
//!   (NEAR AI end-to-end encryption). Only `sha256(ciphertext)` is stored here; nobody outside the
//!   enclave, including the referee, can read it.
//! * The referee opens a match (both stakes are locked), runs one talk turn per agent and one sealed
//!   decision per agent through the enclave, then settles with both signed decisions.
//! * This contract checks every decision's ed25519 signature against a registered enclave key with
//!   `env::ed25519_verify`, checks both decisions were made on the same public transcript and the
//!   agent's own sealed strategy, and pays out. Per-request client keys are published at settle time,
//!   so anyone can decrypt the signed answers and re-check each move (`referee/verify.mjs`).
//! * If the referee disappears, anyone can refund both stakes after `TIMEOUT_BLOCKS`.

use near_sdk::store::{IterableMap, IterableSet, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub mod sig;

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

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct SignedDecision {
    pub agent_id: String,
    pub mv: Move,
    /// NEAR AI signed text "<model>:<sha256(request)>:<sha256(response)>".
    pub text: String,
    pub signature: String,
    /// The enclave's ed25519 public key (hex) that signed it.
    pub tee_key: String,
    /// sha256 of the public talk transcript both agents saw before deciding.
    pub transcript_hash: String,
    /// sha256 of the sealed strategy ciphertext sent in this request.
    pub strategy_hash: String,
    /// Client X25519 secret for this request's encrypted response, published so anyone can decrypt
    /// the answer and confirm `mv`. It cannot decrypt the request (the strategy).
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
    pub decisions: Vec<SignedDecision>,
    /// Public talk lines, in order, as "<agent_id>: <line>".
    pub transcript: Vec<String>,
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
    jackpot: NearToken,
}

fn add(a: NearToken, b: NearToken) -> NearToken {
    a.checked_add(b).expect("overflow")
}
fn sub(a: NearToken, b: NearToken) -> NearToken {
    a.checked_sub(b).expect("underflow")
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
            jackpot: NearToken::from_yoctonear(0),
        }
    }

    // ---------- admin ----------

    /// Register an enclave key read from a NEAR AI attestation report whose TDX quote and fresh nonce
    /// were verified off chain (`referee/attest.mjs`).
    pub fn add_tee_key(&mut self, key: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.tee_keys.insert(sig::normalize_key(&key).unwrap_or_else(|e| env::panic_str(&e)));
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
        require!(id.len() <= 32 && name.len() <= 40, "id or name too long");
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

    /// Re-seal a new strategy (the old hash stays in past matches).
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

    /// Referee opens a match and locks both stakes. Speaking order comes from the block's random seed.
    pub fn open_match(&mut self, a: String, b: String, stake: NearToken) -> Match {
        require!(env::predecessor_account_id() == self.referee, "referee only");
        require!(a != b, "an agent cannot play itself");
        for id in [&a, &b] {
            let ag = self.agents.get_mut(id).expect("no such agent");
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
            decisions: vec![],
            transcript: vec![],
            payout_a: NearToken::from_yoctonear(0),
            payout_b: NearToken::from_yoctonear(0),
            to_jackpot: NearToken::from_yoctonear(0),
        };
        self.matches.push(m.clone());
        m
    }

    /// Referee settles with both signed decisions. Every check below must pass or nothing moves.
    pub fn settle(&mut self, id: u64, transcript: Vec<String>, decisions: Vec<SignedDecision>) -> Match {
        require!(env::predecessor_account_id() == self.referee, "referee only");
        let m = self.matches.get(id as u32).expect("no such match").clone();
        require!(m.status == Status::Open, "match is not open");
        require!(decisions.len() == 2, "need both decisions");

        let transcript_hash = sig::sha256_hex(transcript.join("\n").as_bytes());
        let mut moves = [Move::Split; 2];
        for (i, who) in [&m.a, &m.b].into_iter().enumerate() {
            let d = decisions.iter().find(|d| &d.agent_id == who).expect("decision missing for an agent");
            let agent = self.agents.get(who).expect("no such agent");
            let tee_key = sig::normalize_key(&d.tee_key).unwrap_or_else(|e| env::panic_str(&e));
            require!(self.tee_keys.contains(&tee_key), "signed by a key that is not a registered enclave key");
            let parsed = sig::parse_text(&d.text).unwrap_or_else(|e| env::panic_str(&e));
            require!(parsed.model == self.model, "signed by a different model");
            sig::verify_ed25519(&d.text, &d.signature, &tee_key).unwrap_or_else(|e| env::panic_str(&e));
            require!(d.transcript_hash == transcript_hash, "decision was made on a different transcript");
            require!(d.strategy_hash == agent.strategy_hash, "decision did not use the agent's sealed strategy");
            moves[i] = d.mv;
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

        // Elo: a player "scores" by taking money home; both splitting is a draw.
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
        stored.decisions = decisions;
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
        (
            self.owner.clone(),
            self.referee.clone(),
            self.model.clone(),
            self.tee_keys.iter().cloned().collect(),
            self.jackpot,
            self.matches.len(),
        )
    }

    /// Pure check, for anyone: does this signed answer verify against a registered enclave key?
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

/// Integer Elo with a logistic table approximation (no floats in contracts).
fn elo_delta(ea: i64, eb: i64, score_a: i64, score_b: i64) -> (i64, i64) {
    // expected score for A in percent: 100 / (1 + 10^((eb-ea)/400)), approximated piecewise.
    let diff = (eb - ea).clamp(-800, 800);
    let exp_a = 50 - diff * 45 / 800; // linear approximation of the logistic curve, 5%..95%
    let exp_b = 100 - exp_a;
    (ELO_K * (score_a - exp_a) / 100, ELO_K * (score_b - exp_b) / 100)
}

#[cfg(test)]
mod tests;
