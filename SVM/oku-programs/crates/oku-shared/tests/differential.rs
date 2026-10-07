//! Differential replay: Rust `compute_multiplier` vs the Solidity reference.
//!
//! `EVM/test/differential/vectors.jsonl` is generated from the Solidity
//! (`npm run test:differential` from the repo root); CI regenerates it and
//! fails on any byte difference. Reverts are checked as strictly as values:
//! Rust must return `None` where Solidity reverts. Vectors stay inside the
//! reachable domain, outside the accepted `rpow` overflow divergence
//! (see `rate.rs`).

use oku_shared::rate::compute_multiplier;
use std::path::PathBuf;

/// One generated case. Parsed by hand to keep the crate dependency-free.
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
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
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
        seen.insert(line.to_string());
    }

    // Unique vectors, not lines: the corpus contains duplicates.
    let unique = seen.len();
    assert!(
        unique > 2_500,
        "corpus has only {unique} unique vectors out of {checked} lines. \
         Regenerate it: cd EVM && forge test --match-contract GenerateVectors"
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

    // Guards against the generator silently dropping revert cases.
    assert!(
        revert_cases >= 4,
        "corpus contains only {revert_cases} revert case(s) — the revert half of \
         the differential has degraded. Regenerate with: cd EVM && forge test \
         --match-contract GenerateVectors"
    );

    eprintln!("differential: {checked} vectors matched ({revert_cases} revert cases)");
}
