use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

/// Real requests signed on mainnet: the delegate action that created agent 01365a4b… (proposal #9)
/// and the grant issued for it (proposal #10), with the hashes the DAO's MPC key signed.
const VECTORS: &str = include_str!("../tests/vectors.json");
const OWNER_KEY: &str = "ed25519:E3JR3c1Aw2y5YaDp6hgG1RfNcqLZBKtUHXydqBpwphJt";
const AGENT: &str = "01365a4b32454d1faf835f2126171448d0434be6fbeacdb47f19c4c8837f6115";
const HOST: &str = "api.demo.agentsonintents.com";
/// The account the DAO named to bring requests to sign.
const EXECUTOR: &str = "relayer.near";

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn dao() -> AccountId {
    "agentic.sputnik-dao.near".parse().unwrap()
}

fn context(predecessor: &str, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(1))
        .block_timestamp(now_ms * 1_000_000)
        .block_height(219_444_100)
        .build());
}

fn adapter() -> OwnerAdapter {
    OwnerAdapter::new(dao(), "agent-owner".into(), OWNER_KEY.parse().unwrap(), vec![HOST.into()], vec![EXECUTOR.parse().unwrap()])
}

/// When the grant message was issued: the contract's clock during these tests.
fn grant_time() -> u64 {
    let message: Value = serde_json::from_str(vectors()["message"]["message"].as_str().unwrap()).unwrap();
    message["issued_at_ms"].as_u64().unwrap()
}

fn grant_decision(max_days: u32) -> Decision {
    let message: Value = serde_json::from_str(vectors()["message"]["message"].as_str().unwrap()).unwrap();
    Decision::IssueGrant {
        agent_id: AGENT.into(),
        label: message["label"].as_str().unwrap().into(),
        credential: message["credential"].as_str().unwrap().into(),
        max_days,
    }
}

fn sign_grant(contract: &mut OwnerAdapter, id: u64) {
    let m = &vectors()["message"];
    let nonce = Base64VecU8(near_sdk::base64::Engine::decode(&near_sdk::base64::engine::general_purpose::STANDARD, m["nonce"].as_str().unwrap()).unwrap());
    let _ = contract.sign_message(id, m["message"].as_str().unwrap().into(), nonce, m["recipient"].as_str().unwrap().into());
}

#[test]
fn owner_is_the_implicit_account_of_the_key() {
    context("anyone.near", 0);
    assert_eq!(adapter().owner()["account_id"], "c1bec849b125187a98f7672c52caf0d66115f88a19e55adb6f363e82dfeceb45");
}

#[test]
fn nep413_hash_matches_the_signed_grant() {
    let m = &vectors()["message"];
    let nonce = near_sdk::base64::Engine::decode(&near_sdk::base64::engine::general_purpose::STANDARD, m["nonce"].as_str().unwrap()).unwrap();
    let hash = nep413_hash(m["message"].as_str().unwrap(), &nonce, m["recipient"].as_str().unwrap());
    assert_eq!(to_hex(&hash), m["hash"].as_str().unwrap());
}

#[test]
fn delegate_hash_matches_the_signed_create() {
    let d = &vectors()["delegate"];
    let actions: Vec<FunctionCall> = d["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| FunctionCall {
            method_name: a["method_name"].as_str().unwrap().into(),
            args: Base64VecU8(near_sdk::base64::Engine::decode(&near_sdk::base64::engine::general_purpose::STANDARD, a["args"].as_str().unwrap()).unwrap()),
            gas: U64(a["gas"].as_str().unwrap().parse().unwrap()),
            deposit: U128(a["deposit"].as_str().unwrap().parse().unwrap()),
        })
        .collect();
    let key: PublicKey = d["public_key"].as_str().unwrap().parse().unwrap();
    let bytes = delegate_bytes(
        d["sender_id"].as_str().unwrap(),
        d["receiver_id"].as_str().unwrap(),
        &actions,
        d["nonce"].as_str().unwrap().parse().unwrap(),
        d["max_block_height"].as_str().unwrap().parse().unwrap(),
        &key,
    );
    assert_eq!(to_hex(&sha256_prefixed(NEP461_DELEGATE_TAG, &bytes)), d["hash"].as_str().unwrap());
}

#[test]
#[should_panic(expected = "only the DAO approves decisions")]
fn only_the_dao_approves() {
    context("member.near", 0);
    adapter().approve(grant_decision(7), 24);
}

#[test]
fn signs_a_grant_the_dao_approved() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    let id = contract.approve(grant_decision(7), 24);
    context(EXECUTOR, grant_time());
    sign_grant(&mut contract, id);
    assert!(contract.decision(id).unwrap().used);
}

#[test]
#[should_panic(expected = "decision already signed")]
fn signs_once() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    let id = contract.approve(grant_decision(7), 24);
    context(EXECUTOR, grant_time());
    sign_grant(&mut contract, id);
    sign_grant(&mut contract, id);
}

#[test]
#[should_panic(expected = "grant too long")]
fn refuses_a_longer_grant_than_approved() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    let id = contract.approve(grant_decision(6), 24);
    context(EXECUTOR, grant_time());
    sign_grant(&mut contract, id);
}

#[test]
#[should_panic(expected = "different label")]
fn refuses_a_grant_the_dao_did_not_approve() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    let Decision::IssueGrant { agent_id, credential, max_days, .. } = grant_decision(7) else { unreachable!() };
    let id = contract.approve(Decision::IssueGrant { agent_id, label: "someone-else".into(), credential, max_days }, 24);
    context(EXECUTOR, grant_time());
    sign_grant(&mut contract, id);
}

#[test]
#[should_panic(expected = "decision expired")]
fn refuses_after_the_decision_expires() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    let id = contract.approve(grant_decision(7), 1);
    context(EXECUTOR, grant_time() + 2 * 3_600_000);
    sign_grant(&mut contract, id);
}

fn freeze_request(wallet: &str, extra: Option<&str>) -> Vec<FunctionCall> {
    let call = |method: &str, args: Value| FunctionCall {
        method_name: method.into(),
        args: Base64VecU8(args.to_string().into_bytes()),
        gas: U64(50_000_000_000_000),
        deposit: U128(0),
    };
    let mut actions = vec![
        call("store_wallet_policy", json!({ "wallet_pubkey": wallet, "encrypted_data": "…" })),
        call("freeze_wallet", json!({ "wallet_pubkey": wallet })),
    ];
    if let Some(method) = extra {
        actions.push(call(method, json!({ "wallet_pubkey": wallet })));
    }
    actions
}

#[test]
fn signs_a_freeze_of_the_approved_wallet() {
    context(dao().as_str(), 0);
    let mut contract = adapter();
    let id = contract.approve(Decision::Freeze { agent_id: AGENT.into(), wallet: "ed25519:aa".into() }, 24);
    context(EXECUTOR, 0);
    let _ = contract.sign_delegate(id, WALLETS.parse().unwrap(), freeze_request("ed25519:aa", None), U64(1), U64(219_450_000));
    assert!(contract.decision(id).unwrap().used);
}

#[test]
#[should_panic(expected = "different wallet")]
fn refuses_to_freeze_another_wallet() {
    context(dao().as_str(), 0);
    let mut contract = adapter();
    let id = contract.approve(Decision::Freeze { agent_id: AGENT.into(), wallet: "ed25519:aa".into() }, 24);
    context(EXECUTOR, 0);
    let _ = contract.sign_delegate(id, WALLETS.parse().unwrap(), freeze_request("ed25519:bb", None), U64(1), U64(219_450_000));
}

#[test]
#[should_panic(expected = "unexpected method")]
fn refuses_extra_calls_in_a_freeze() {
    context(dao().as_str(), 0);
    let mut contract = adapter();
    let id = contract.approve(Decision::Freeze { agent_id: AGENT.into(), wallet: "ed25519:aa".into() }, 24);
    context(EXECUTOR, 0);
    let _ = contract.sign_delegate(id, WALLETS.parse().unwrap(), freeze_request("ed25519:aa", Some("delete_wallet_policy")), U64(1), U64(219_450_000));
}

#[test]
#[should_panic(expected = "requests may only call the wallet provider")]
fn refuses_other_receivers() {
    context(dao().as_str(), 0);
    let mut contract = adapter();
    let id = contract.approve(Decision::Freeze { agent_id: AGENT.into(), wallet: "ed25519:aa".into() }, 24);
    context(EXECUTOR, 0);
    let _ = contract.sign_delegate(id, "evil.near".parse().unwrap(), freeze_request("ed25519:aa", None), U64(1), U64(219_450_000));
}

#[test]
#[should_panic(expected = "decision is not for a message")]
fn a_freeze_decision_cannot_sign_a_grant() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    let id = contract.approve(Decision::Freeze { agent_id: AGENT.into(), wallet: "ed25519:aa".into() }, 24);
    context(EXECUTOR, grant_time());
    sign_grant(&mut contract, id);
}

#[test]
fn signs_an_approved_raw_hash() {
    context(dao().as_str(), 0);
    let mut contract = adapter();
    let id = contract.approve(Decision::RawHash { hash: "11".repeat(32), note: "create the agent".into() }, 24);
    context(EXECUTOR, 0);
    let _ = contract.sign_hash(id);
    assert!(contract.decision(id).unwrap().used);
}

#[test]
#[should_panic(expected = "only an executor signs")]
fn no_one_else_can_spend_a_decision() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    let id = contract.approve(grant_decision(7), 24);
    context("stranger.near", grant_time());
    sign_grant(&mut contract, id);
}

#[test]
#[should_panic(expected = "only an executor signs")]
fn not_even_the_dao_signs_unless_it_is_an_executor() {
    context(dao().as_str(), 0);
    let mut contract = adapter();
    let id = contract.approve(Decision::RawHash { hash: "11".repeat(32), note: "create the agent".into() }, 24);
    let _ = contract.sign_hash(id);
}

#[test]
#[should_panic(expected = "only the DAO sets executors")]
fn only_the_dao_sets_executors() {
    context(EXECUTOR, 0);
    adapter().set_executors(vec![EXECUTOR.parse().unwrap(), "stranger.near".parse().unwrap()]);
}

#[test]
fn an_executor_the_dao_names_can_sign() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    contract.set_executors(vec!["server.near".parse().unwrap()]);
    let id = contract.approve(grant_decision(7), 24);
    context("server.near", grant_time());
    sign_grant(&mut contract, id);
    assert!(contract.decision(id).unwrap().used);
}

#[test]
#[should_panic(expected = "only an executor signs")]
fn a_removed_executor_can_no_longer_sign() {
    context(dao().as_str(), grant_time());
    let mut contract = adapter();
    contract.set_executors(vec![]);
    let id = contract.approve(grant_decision(7), 24);
    context(EXECUTOR, grant_time());
    sign_grant(&mut contract, id);
}
