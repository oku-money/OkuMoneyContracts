//! Cross-language differential replay: Rust vs the Solidity reference.
//!
//! # What this guards
//!
//! `compute_multiplier` exists three times — Solidity, Rust, TypeScript — and
//! all three must return the same integer for the same inputs. Cross-chain
//! determinism depends on it entirely, and **nothing on-chain on either stack
//! can detect a divergence**: each deployment is independent, with no
//! messaging, no light client, and no state proof between them. A silent drift
//! between these implementations would show up as chains quietly disagreeing
//! about how much everyone owns.
//!
//! Before this existed, the three were kept in agreement by code review. That
//! is not a control; this is.
//!
//! # The corpus
//!
//! `EVM/test/differential/vectors.jsonl` is generated FROM the Solidity, which
//! is the reference implementation — it shipped first and it is what the live
//! EVM deployments run. Regenerate with:
//!
//! ```text
//! cd EVM && forge test --match-contract GenerateVectors -vv
//! ```
//!
//! Each line records the inputs, whether Solidity REVERTED, and the value if it
//! did not. Reverts are checked as strictly as values: Rust returns `None` and
//! TypeScript throws where Solidity reverts, and a divergence in the revert
//! surface is still a divergence. (One such bug — the atomic setter accepting a
//! halt plus a successor — was found by hand in the instruction layer during
//! this work, which is exactly why the corpus records them.)
//!
//! # Domain
//!
//! Vectors are confined to what a compliant writer can produce. Outside it
//! there is a documented, accepted divergence in the far tail
//! (see `rate.rs` § reachability): Solidity reverts when an intermediate *product*
//! exceeds `uint256`, whereas this port returns `None` when a *quotient*
//! exceeds `u128`, and the Rust bound binds first. Both lie far beyond any
//! reachable schedule. See the generator for the full reasoning.

use oku_shared::rate::compute_multiplier;
use std::path::PathBuf;

/// One generated case. Parsed by hand rather than with serde — this crate is
/// deliberately dependency-free (see `lib.rs` design rules), and a dev-dependency
/// on serde purely for a flat object of string fields is not worth the drift
/// surface it would add.
#[derive(Debug)]
struct Vector {
    base: u128,
    rate: u128,
    anchor: i64,
    rate_end: i64,
    pending_rate: u128,
    pending_rate_end: i64,
    now_ts: i64,
    reverted: bool,
    expected: u128,
}

/// Pull `"key":"value"` or `"key":literal` out of a flat JSON object.
fn field<'a>(line: &'a str, key: &str) -> &'a str {
    let needle = format!("\"{key}\":");
    let start = line
        .find(&needle)
        .unwrap_or_else(|| panic!("missing key {key} in: {line}"))
        + needle.len();
    let rest = &line[start..];
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"').expect("unterminated string");
        &stripped[..end]
    } else {
        let end = rest.find([',', '}']).expect("unterminated literal");
        &rest[..end]
    }
}

fn parse(line: &str) -> Vector {
    Vector {
        base: field(line, "base").parse().unwrap(),
        rate: field(line, "rate").parse().unwrap(),
        anchor: field(line, "anchor").parse().unwrap(),
        rate_end: field(line, "rateEnd").parse().unwrap(),
        pending_rate: field(line, "pendingRate").parse().unwrap(),
        pending_rate_end: field(line, "pendingRateEnd").parse().unwrap(),
        now_ts: field(line, "nowTs").parse().unwrap(),
        reverted: field(line, "reverted") == "true",
        expected: field(line, "expected").parse().unwrap(),
    }
}

fn corpus_path() -> PathBuf {
    // crates/oku-shared -> oku-programs -> SVM -> contracts
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../EVM/test/differential/vectors.jsonl")
}

#[test]
fn matches_solidity_reference_exactly() {
    let path = corpus_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read differential corpus at {}: {e}.\n\
             Generate it with: cd EVM && forge test --match-contract GenerateVectors",
            path.display()
        )
    });

    let mut checked = 0usize;
    let mut revert_cases = 0usize;
    let mut mismatches: Vec<String> = Vec::new();

    for (i, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v = parse(line);

        let got = compute_multiplier(
            v.base,
            v.rate,
            v.anchor,
            v.rate_end,
            v.pending_rate,
            v.pending_rate_end,
            v.now_ts,
        );

        if v.reverted {
            revert_cases += 1;
            if got.is_some() {
                mismatches.push(format!(
                    "line {}: Solidity REVERTED, Rust returned {:?}\n  {line}",
                    i + 1,
                    got
                ));
            }
        } else {
            match got {
                Some(actual) if actual == v.expected => {}
                Some(actual) => mismatches.push(format!(
                    "line {}: expected {}, got {}\n  {line}",
                    i + 1,
                    v.expected,
                    actual
                )),
                None => mismatches.push(format!(
                    "line {}: Solidity returned {}, Rust returned None\n  {line}",
                    i + 1,
                    v.expected
                )),
            }
        }
        checked += 1;
    }

    assert!(
        checked > 1_000,
        "corpus looks truncated: only {checked} vectors. Regenerate it."
    );
    assert!(
        mismatches.is_empty(),
        "{} of {checked} vectors diverged from the Solidity reference:\n\n{}",
        mismatches.len(),
        mismatches
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n\n")
    );

    // The revert half of the corpus is the easiest thing to lose silently: if
    // GenerateVectors stopped emitting revert cases, every value check would
    // still pass and the "one stack accepts what the other rejects" guard would
    // simply evaporate.
    assert!(
        revert_cases >= 4,
        "corpus contains only {revert_cases} revert case(s) — the revert half of \
         the differential has degraded. Regenerate with: cd EVM && forge test \
         --match-contract GenerateVectors"
    );

    eprintln!("differential: {checked} vectors matched ({revert_cases} revert cases)");
}
