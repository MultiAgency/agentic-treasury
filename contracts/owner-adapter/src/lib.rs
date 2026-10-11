//! The owner of an Agent API agent, governed by a DAO.
//!
//! The agent's owner is the implicit account of a key that NEAR's MPC network (`v1.signer`)
//! derives from this contract, so only this contract can sign as the owner. The DAO approves
//! readable decisions here, at its own pace ("freeze agent X", "issue grant Y"); afterwards an
//! executor the DAO named brings the Agent API's fresh request for that decision, and this contract
//! has `v1.signer` sign it only if the request matches what the DAO approved. Each decision signs once.
//! Only executors may sign: a decision is spent by its first signature, so anyone else could spend
//! it on a request the Agent API never issued (a NEP-413 nonce is the caller's to choose).
//!
//! What a decision checks:
//! - NEP-413 requests (grants, off-chain policy changes) are read in full: agent, owner, and the
//!   exact grant or policy.
//! - NEP-366 requests (freeze, unfreeze) are checked by structure: receiver, methods and wallet.
//!   The policy blob they carry is encrypted for the wallet provider and cannot be read here.
//! - `RawHash` signs a hash the DAO approved as-is, for anything else. It is labelled as unread.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PublicKey};

const SIGNER: &str = "v1.signer";
const WALLETS: &str = "outlayer.near";
const SIGN_GAS: Gas = Gas::from_tgas(50);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// The most a request may attach to the wallet provider: storage for one policy.
const MAX_STORAGE_DEPOSIT: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const NEP413_TAG: u32 = (1 << 31) + 413;
const NEP461_DELEGATE_TAG: u32 = (1 << 30) + 366;

/// What the DAO approves. Field names are what members read in the proposal.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// Issue the grant whose credential fingerprint is `credential`, for at most `max_days`.
    IssueGrant { agent_id: String, label: String, credential: String, max_days: u32 },
    /// Replace the agent's policy with exactly `policy` (a change that needs no blockchain transaction).
    SetPolicy { agent_id: String, policy: Value },
    /// Freeze the agent's wallet: it can move nothing until unfrozen.
    Freeze { agent_id: String, wallet: String },
    /// Unfreeze the agent's wallet.
    Unfreeze { agent_id: String, wallet: String },
    /// Sign this hash as-is. Unread: only `note` says what it is for.
    RawHash { hash: String, note: String },
}

#[near(serializers = [borsh])]
pub struct Stored {
    decision: String,
    expires_at_ns: u64,
    used: bool,
}

#[near(serializers = [json])]
pub struct DecisionView {
    pub id: u64,
    pub decision: Decision,
    pub expires_at_ns: U64,
    pub used: bool,
}

/// One function call in a NEP-366 request, as the Agent API generated it.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct FunctionCall {
    pub method_name: String,
    /// The exact argument bytes (JSON) the wallet provider will receive.
    pub args: Base64VecU8,
    pub gas: U64,
    pub deposit: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct OwnerAdapter {
    dao: AccountId,
    /// The MPC path whose key, derived from this contract, owns the agent.
    path: String,
    owner_key: PublicKey,
    /// Agent API hosts whose requests may be signed (the NEP-413 `recipient`).
    recipients: Vec<String>,
    /// Accounts that may bring requests to sign; set by the DAO.
    executors: Vec<AccountId>,
    decisions: IterableMap<u64, Stored>,
    next_id: u64,
}

#[near]
impl OwnerAdapter {
    /// `owner_key` is `v1.signer.derived_public_key({ path, predecessor: <this contract>, domain_id: 1 })`.
    #[init]
    pub fn new(dao: AccountId, path: String, owner_key: PublicKey, recipients: Vec<String>, executors: Vec<AccountId>) -> Self {
        require!(owner_key.as_bytes().len() == 33 && owner_key.as_bytes()[0] == 0, "owner_key must be ed25519");
        Self { dao, path, owner_key, recipients, executors, decisions: IterableMap::new(b"d"), next_id: 0 }
    }

    /// The owner account (the implicit account of the owner key) and its key, and who may sign.
    pub fn owner(&self) -> Value {
        json!({
            "account_id": self.owner_account(),
            "public_key": String::from(&self.owner_key),
            "dao": self.dao,
            "path": self.path,
            "executors": self.executors,
        })
    }

    /// Replaces the accounts that may bring requests to sign; only the DAO.
    pub fn set_executors(&mut self, executors: Vec<AccountId>) {
        require!(env::predecessor_account_id() == self.dao, "only the DAO sets executors");
        self.executors = executors;
    }

    /// Records a decision; only the DAO, so only by proposal. Valid for `valid_hours`, signs once.
    pub fn approve(&mut self, decision: Decision, valid_hours: u32) -> u64 {
        require!(env::predecessor_account_id() == self.dao, "only the DAO approves decisions");
        let id = self.next_id;
        self.next_id += 1;
        let expires_at_ns = env::block_timestamp() + u64::from(valid_hours) * 3_600_000_000_000;
        self.decisions.insert(id, Stored { decision: serde_json::to_string(&decision).unwrap(), expires_at_ns, used: false });
        id
    }

    /// Withdraws a decision that has not signed yet; only the DAO.
    pub fn revoke(&mut self, id: u64) {
        require!(env::predecessor_account_id() == self.dao, "only the DAO revokes decisions");
        self.decisions.remove(&id);
    }

    pub fn decision(&self, id: u64) -> Option<DecisionView> {
        self.decisions.get(&id).map(|s| view(id, s))
    }

    pub fn decisions(&self, from: u64, limit: u64) -> Vec<DecisionView> {
        (from..self.next_id).filter_map(|id| self.decision(id)).take(limit as usize).collect()
    }

    /// Signs a NEP-413 request (`message`, `nonce`, `recipient` exactly as the Agent API generated
    /// them) if it matches decision `id`. Returns the MPC signature.
    #[payable]
    pub fn sign_message(&mut self, id: u64, message: String, nonce: Base64VecU8, recipient: String) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yoctoNEAR");
        let decision = self.take(id);
        let msg: Value = serde_json::from_str(&message).unwrap_or_else(|_| env::panic_str("message is not JSON"));
        self.check_message(&decision, &msg, &recipient);
        require!(nonce.0.len() == 32, "nonce must be 32 bytes");
        self.sign(id, nep413_hash(&message, &nonce.0, &recipient))
    }

    /// Signs a NEP-366 request to the wallet provider if it matches decision `id`. The sender and
    /// key are always the owner's. Returns the MPC signature.
    #[payable]
    pub fn sign_delegate(&mut self, id: u64, receiver_id: AccountId, actions: Vec<FunctionCall>, nonce: U64, max_block_height: U64) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yoctoNEAR");
        let decision = self.take(id);
        require!(receiver_id.as_str() == WALLETS, "requests may only call the wallet provider");
        require!(max_block_height.0 > env::block_height(), "request already expired");
        check_delegate(&decision, &actions);
        let bytes = delegate_bytes(&self.owner_account(), receiver_id.as_str(), &actions, nonce.0, max_block_height.0, &self.owner_key);
        self.sign(id, sha256_prefixed(NEP461_DELEGATE_TAG, &bytes))
    }

    /// Signs the hash a `RawHash` decision approved.
    #[payable]
    pub fn sign_hash(&mut self, id: u64) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yoctoNEAR");
        match self.take(id) {
            Decision::RawHash { hash, .. } => {
                let bytes = from_hex(&hash);
                require!(bytes.len() == 32, "hash must be 32 bytes");
                self.sign(id, bytes)
            }
            _ => env::panic_str("decision is not a raw hash"),
        }
    }

    /// Passes the signature through; on failure the decision can sign again.
    #[private]
    pub fn on_signed(&mut self, id: u64, #[callback_result] result: Result<Value, PromiseError>) -> Option<Value> {
        match result {
            Ok(signature) => Some(signature),
            Err(_) => {
                if let Some(stored) = self.decisions.get_mut(&id) {
                    stored.used = false;
                }
                None
            }
        }
    }
}

impl OwnerAdapter {
    fn owner_account(&self) -> String {
        to_hex(&self.owner_key.as_bytes()[1..])
    }

    /// The decision, if the caller is an executor and it is approved, unexpired and unused; marks it used.
    fn take(&mut self, id: u64) -> Decision {
        require!(self.executors.contains(&env::predecessor_account_id()), "only an executor signs");
        let stored = self.decisions.get_mut(&id).unwrap_or_else(|| env::panic_str("no such decision"));
        require!(!stored.used, "decision already signed");
        require!(env::block_timestamp() < stored.expires_at_ns, "decision expired");
        stored.used = true;
        serde_json::from_str(&stored.decision).unwrap()
    }

    fn check_message(&self, decision: &Decision, msg: &Value, recipient: &str) {
        require!(self.recipients.iter().any(|r| r == recipient), "unknown Agent API host");
        require!(msg["recipient"] == recipient, "recipient mismatch");
        require!(msg["network"] == "mainnet", "not mainnet");
        require!(msg["owner"]["account_id"] == self.owner_account(), "not this owner");
        require!(msg["owner"]["public_key"] == String::from(&self.owner_key), "not this owner's key");
        let domain = msg["domain"].as_str().unwrap_or_default();
        match decision {
            Decision::IssueGrant { agent_id, label, credential, max_days } => {
                require!(domain.starts_with("near-intents-agent-api.agent-grant."), "not a grant");
                require!(msg["agent_id"] == agent_id.as_str(), "different agent");
                require!(msg["label"] == label.as_str(), "different label");
                require!(msg["credential"] == credential.as_str(), "different credential");
                let issued = msg["issued_at_ms"].as_u64().unwrap_or_default();
                let expires = msg["expires_at_ms"].as_u64().unwrap_or(u64::MAX);
                require!(expires.saturating_sub(issued) <= u64::from(*max_days) * 86_400_000, "grant too long");
            }
            Decision::SetPolicy { agent_id, policy } => {
                require!(domain.starts_with("near-intents-agent-api.owner-admin."), "not an owner action");
                require!(msg["action"] == "update_policy", "not a policy update");
                require!(msg["agent_id"] == agent_id.as_str(), "different agent");
                require!(&msg["policy"] == policy, "different policy");
                let expires = msg["expires_at_ms"].as_u64().unwrap_or_default();
                require!(expires > env::block_timestamp_ms(), "request expired");
            }
            _ => env::panic_str("decision is not for a message"),
        }
    }

    fn sign(&mut self, id: u64, hash: Vec<u8>) -> Promise {
        let request = json!({ "request": { "path": self.path, "payload_v2": { "Eddsa": to_hex(&hash) }, "domain_id": 1 } });
        Promise::new(SIGNER.parse().unwrap())
            .function_call("sign", request.to_string().into_bytes(), NearToken::from_yoctonear(1), SIGN_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_signed(id))
    }
}

fn view(id: u64, s: &Stored) -> DecisionView {
    DecisionView { id, decision: serde_json::from_str(&s.decision).unwrap(), expires_at_ns: U64(s.expires_at_ns), used: s.used }
}

/// Freeze and unfreeze touch only the approved wallet, with nothing but its own methods.
fn check_delegate(decision: &Decision, actions: &[FunctionCall]) {
    let (wallet, toggle) = match decision {
        Decision::Freeze { wallet, .. } => (wallet, "freeze_wallet"),
        Decision::Unfreeze { wallet, .. } => (wallet, "unfreeze_wallet"),
        _ => env::panic_str("decision is not for a delegate action"),
    };
    require!(actions.iter().any(|a| a.method_name == toggle), "request does not freeze or unfreeze");
    for action in actions {
        require!(action.method_name == toggle || action.method_name == "store_wallet_policy", "unexpected method");
        require!(action.deposit.0 <= MAX_STORAGE_DEPOSIT, "deposit too large");
        let args: Value = serde_json::from_slice(&action.args.0).unwrap_or_else(|_| env::panic_str("args are not JSON"));
        require!(args["wallet_pubkey"] == wallet.as_str(), "different wallet");
    }
}

fn borsh_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// borsh(DelegateAction) with only function-call actions.
fn delegate_bytes(sender: &str, receiver: &str, actions: &[FunctionCall], nonce: u64, max_block_height: u64, key: &PublicKey) -> Vec<u8> {
    let mut out = Vec::new();
    borsh_string(&mut out, sender);
    borsh_string(&mut out, receiver);
    out.extend_from_slice(&(actions.len() as u32).to_le_bytes());
    for action in actions {
        out.push(2); // Action::FunctionCall
        borsh_string(&mut out, &action.method_name);
        out.extend_from_slice(&(action.args.0.len() as u32).to_le_bytes());
        out.extend_from_slice(&action.args.0);
        out.extend_from_slice(&action.gas.0.to_le_bytes());
        out.extend_from_slice(&action.deposit.0.to_le_bytes());
    }
    out.extend_from_slice(&nonce.to_le_bytes());
    out.extend_from_slice(&max_block_height.to_le_bytes());
    out.extend_from_slice(key.as_bytes()); // curve type (0 = ed25519) then 32 bytes
    out
}

fn sha256_prefixed(tag: u32, body: &[u8]) -> Vec<u8> {
    let mut bytes = tag.to_le_bytes().to_vec();
    bytes.extend_from_slice(body);
    env::sha256(&bytes)
}

/// NEP-413: sha256(borsh(tag) ++ borsh({ message, nonce, recipient, callback_url: None })).
fn nep413_hash(message: &str, nonce: &[u8], recipient: &str) -> Vec<u8> {
    let mut body = Vec::new();
    borsh_string(&mut body, message);
    body.extend_from_slice(nonce);
    borsh_string(&mut body, recipient);
    body.push(0);
    sha256_prefixed(NEP413_TAG, &body)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2).unwrap_or("zz"), 16).unwrap_or_else(|_| env::panic_str("bad hex")))
        .collect()
}

#[cfg(test)]
mod tests;
