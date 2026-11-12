use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const V: &str = include_str!("../tests/vector.json");
const ONE: NearToken = NearToken::from_near(1);

fn v() -> Value {
    serde_json::from_str(V).unwrap()
}
fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn as_caller(who: &str, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .build());
}
fn decisions(case: &str) -> Vec<SignedDecision> {
    serde_json::from_value(v()[case].clone()).unwrap()
}
fn transcript() -> Vec<String> {
    serde_json::from_value(v()["transcript"].clone()).unwrap()
}

/// owner registers the test enclave key; two players make agents with 5 NEAR each; referee opens a 1 NEAR match.
fn setup() -> Pact {
    as_caller("owner.testnet", NearToken::from_near(0));
    let mut c = Pact::new(acc("owner.testnet"), acc("referee.testnet"), v()["model"].as_str().unwrap().into());
    c.add_tee_key(v()["tee_key"].as_str().unwrap().into());
    as_caller("alice.testnet", NearToken::from_near(5));
    c.create_agent("fox".into(), "Fox".into(), v()["strategyA"].as_str().unwrap().into());
    as_caller("bob.testnet", NearToken::from_near(5));
    c.create_agent("owl".into(), "Owl".into(), v()["strategyB"].as_str().unwrap().into());
    as_caller("referee.testnet", NearToken::from_near(0));
    let m = c.open_match("fox".into(), "owl".into(), ONE);
    assert_eq!(m.id, 0);
    assert_eq!(c.get_agent("fox".into()).unwrap().balance, NearToken::from_near(4), "stake locked");
    c
}

#[test]
fn both_split_get_stakes_back() {
    let mut c = setup();
    let m = c.settle(0, transcript(), decisions("split_split"));
    assert_eq!(m.status, Status::Settled);
    assert_eq!(m.payout_a, ONE);
    assert_eq!(m.payout_b, ONE);
    assert_eq!(c.get_agent("fox".into()).unwrap().balance, NearToken::from_near(5));
}

#[test]
fn stealer_takes_the_pot() {
    let mut c = setup();
    let m = c.settle(0, transcript(), decisions("steal_split"));
    assert_eq!(m.payout_a, NearToken::from_near(2));
    assert_eq!(m.payout_b, NearToken::from_near(0));
    let fox = c.get_agent("fox".into()).unwrap();
    assert_eq!(fox.balance, NearToken::from_near(6));
    assert!(fox.elo > 1000);
    assert!(c.get_agent("owl".into()).unwrap().elo < 1000);
}

#[test]
fn both_steal_feeds_the_jackpot() {
    let mut c = setup();
    let m = c.settle(0, transcript(), decisions("steal_steal"));
    assert_eq!(m.to_jackpot, NearToken::from_near(2));
    assert_eq!(c.info().4, NearToken::from_near(2));
}

#[test]
#[should_panic(expected = "edited after signing")]
fn referee_cannot_flip_a_move_inside_the_signed_text() {
    let mut c = setup();
    let mut d = decisions("split_split");
    // Tamper with the response hash the enclave signed (what a referee would have to do to swap the answer).
    let t = d[0].text.clone();
    let last = t.rfind(':').unwrap();
    d[0].text = format!("{}{}", &t[..=last], "0".repeat(64));
    c.settle(0, transcript(), d);
}

#[test]
#[should_panic(expected = "not a registered enclave key")]
fn answers_signed_outside_the_enclave_are_rejected() {
    let mut c = setup();
    let mut d = decisions("split_split");
    d[0].tee_key = "11".repeat(32);
    c.settle(0, transcript(), d);
}

#[test]
#[should_panic(expected = "different transcript")]
fn referee_cannot_feed_agents_different_conversations() {
    let mut c = setup();
    let mut t = transcript();
    t[1] = "owl: I will steal.".into();
    c.settle(0, t, decisions("split_split"));
}

#[test]
#[should_panic(expected = "sealed strategy")]
fn decision_must_use_the_agents_own_strategy() {
    let mut c = setup();
    as_caller("alice.testnet", NearToken::from_near(0));
    c.reseal("fox".into(), "c".repeat(64));
    as_caller("referee.testnet", NearToken::from_near(0));
    c.settle(0, transcript(), decisions("split_split"));
}

#[test]
#[should_panic(expected = "referee only")]
fn players_cannot_settle() {
    let mut c = setup();
    as_caller("alice.testnet", NearToken::from_near(0));
    c.settle(0, transcript(), decisions("steal_split"));
}

#[test]
fn stale_match_refunds_both_stakes() {
    let mut c = setup();
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc("anyone.testnet"))
        .block_height(TIMEOUT_BLOCKS + 1)
        .build());
    let m = c.refund_stale(0);
    assert_eq!(m.status, Status::Refunded);
    assert_eq!(c.get_agent("fox".into()).unwrap().balance, NearToken::from_near(5));
    assert_eq!(c.get_agent("owl".into()).unwrap().balance, NearToken::from_near(5));
}

#[test]
#[should_panic(expected = "not stale yet")]
fn fresh_match_cannot_be_refunded() {
    let mut c = setup();
    c.refund_stale(0);
}

#[test]
#[should_panic(expected = "match is not open")]
fn match_settles_only_once() {
    let mut c = setup();
    c.settle(0, transcript(), decisions("split_split"));
    c.settle(0, transcript(), decisions("steal_split"));
}

#[test]
fn verify_signed_view() {
    let c = setup();
    let d = &decisions("split_split")[0];
    assert_eq!(c.verify_signed(d.text.clone(), d.signature.clone(), d.tee_key.clone()), "ok");
    let bad = format!("{}x", d.text);
    assert!(c.verify_signed(bad, d.signature.clone(), d.tee_key.clone()).contains("edited"));
}
