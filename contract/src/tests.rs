use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const V: &str = include_str!("../tests/vector.json");
const ONE: NearToken = NearToken::from_near(1);

fn v() -> Value {
    serde_json::from_str(V).unwrap()
}
fn s(k: &str) -> String {
    v()[k].as_str().unwrap().to_string()
}
fn acc(x: &str) -> AccountId {
    x.parse().unwrap()
}
fn as_caller(who: &str, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .prepaid_gas(near_sdk::Gas::from_tgas(300))
        .build());
}
fn answers(k: &str) -> Vec<SignedAnswer> {
    serde_json::from_value(v()[k].clone()).unwrap()
}
fn one(k: &str) -> SignedAnswer {
    serde_json::from_value(v()[k].clone()).unwrap()
}

/// Owner registers the stand-in enclave key; two players make agents with 5 NEAR; referee opens a 1 NEAR match.
fn setup() -> Pact {
    as_caller("owner.testnet", NearToken::from_near(0));
    let mut c = Pact::new(acc("owner.testnet"), acc("referee.testnet"), s("model"));
    c.add_tee_key(s("tee_key"));
    as_caller("alice.testnet", NearToken::from_near(5));
    c.create_agent("fox".into(), "Fox".into(), s("strategy_hash_fox"));
    as_caller("bob.testnet", NearToken::from_near(5));
    c.create_agent("owl".into(), "Owl".into(), s("strategy_hash_owl"));
    as_caller("referee.testnet", NearToken::from_near(0));
    let m = c.open_match("fox".into(), "owl".into(), ONE);
    assert_eq!(m.first, "fox");
    assert_eq!(c.get_agent("fox".into()).unwrap().balance, NearToken::from_near(4), "stake locked");
    c
}

#[test]
fn both_split_get_stakes_back_and_transcript_is_built_on_chain() {
    let mut c = setup();
    let m = c.settle(0, answers("talk"), answers("split_split"));
    assert_eq!(m.status, Status::Settled);
    assert_eq!(m.moves, vec![Move::Split, Move::Split]);
    let t: Vec<String> = serde_json::from_value(v()["transcript"].clone()).unwrap();
    assert_eq!(m.transcript, t, "contract decrypted the talk answers itself");
    assert_eq!(m.reveals[0], "Told you.");
    assert_eq!((m.payout_a, m.payout_b), (ONE, ONE));
    assert_eq!(c.get_agent("fox".into()).unwrap().balance, NearToken::from_near(5));
}

#[test]
fn stealer_takes_the_pot() {
    let mut c = setup();
    let m = c.settle(0, answers("talk"), answers("steal_split"));
    assert_eq!(m.moves, vec![Move::Steal, Move::Split]);
    assert_eq!(m.payout_a, NearToken::from_near(2));
    let fox = c.get_agent("fox".into()).unwrap();
    assert_eq!(fox.balance, NearToken::from_near(6));
    assert!(fox.elo > 1000 && c.get_agent("owl".into()).unwrap().elo < 1000);
}

#[test]
fn both_steal_feeds_the_jackpot() {
    let mut c = setup();
    let m = c.settle(0, answers("talk"), answers("steal_steal"));
    assert_eq!(m.to_jackpot, NearToken::from_near(2));
    assert_eq!(c.info().4, NearToken::from_near(2));
}

#[test]
#[should_panic(expected = "response bytes do not match the signed hash")]
fn referee_cannot_swap_in_its_own_answer() {
    let mut c = setup();
    let mut d = answers("split_split");
    d[1] = one("forged_answer");
    c.settle(0, answers("talk"), d);
}

#[test]
#[should_panic(expected = "signature does not verify")]
fn referee_cannot_edit_the_signed_text() {
    let mut c = setup();
    let mut d = answers("split_split");
    let t = d[0].text.clone();
    let cut = t.rfind(':').unwrap();
    d[0].text = format!("{}{}", &t[..=cut], "0".repeat(64));
    c.settle(0, answers("talk"), d);
}

#[test]
#[should_panic(expected = "public message 2 is not the text this contract expects")]
fn referee_cannot_lie_to_an_agent_about_the_conversation() {
    let mut c = setup();
    let mut d = answers("split_split");
    d[1] = one("lying_prompt");
    c.settle(0, answers("talk"), d);
}

#[test]
#[should_panic(expected = "not this agent's strategy")]
fn the_sealed_message_must_be_the_agents_own_strategy() {
    let mut c = setup();
    let mut d = answers("split_split");
    d[1] = one("wrong_strategy");
    c.settle(0, answers("talk"), d);
}

#[test]
#[should_panic(expected = "not a registered enclave key")]
fn answers_signed_outside_the_enclave_are_rejected() {
    let mut c = setup();
    let mut d = answers("split_split");
    d[0].tee_key = "11".repeat(32);
    c.settle(0, answers("talk"), d);
}

#[test]
#[should_panic(expected = "talk answers out of speaking order")]
fn talk_must_follow_the_on_chain_speaking_order() {
    let mut c = setup();
    let mut t = answers("talk");
    t.reverse();
    c.settle(0, t, answers("split_split"));
}

#[test]
#[should_panic(expected = "does not decrypt")]
fn a_wrong_response_key_cannot_produce_a_move() {
    let mut c = setup();
    let mut d = answers("split_split");
    d[0].response_key = "22".repeat(32);
    c.settle(0, answers("talk"), d);
}

#[test]
#[should_panic(expected = "referee only")]
fn players_cannot_settle() {
    let mut c = setup();
    as_caller("alice.testnet", NearToken::from_near(0));
    c.settle(0, answers("talk"), answers("steal_split"));
}

#[test]
#[should_panic(expected = "match is not open")]
fn match_settles_only_once() {
    let mut c = setup();
    c.settle(0, answers("talk"), answers("split_split"));
    c.settle(0, answers("talk"), answers("steal_split"));
}

#[test]
fn stale_match_refunds_both_stakes() {
    let mut c = setup();
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc("anyone.testnet")).block_height(TIMEOUT_BLOCKS + 1).build());
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
fn text_helpers_match_the_referee() {
    assert_eq!(text::clean_line("<think>hm</think>\n\"Hello there.\""), "Hello there.");
    assert_eq!(text::clean_line("   "), "...");
    assert_eq!(text::parse_decision("x {\"move\":\"steal\",\"reveal\":\"bye\"} y"), Some((Move::Steal, "bye".into())));
    assert_eq!(text::parse_decision("{\"move\":\"maybe\"}"), None);
}
