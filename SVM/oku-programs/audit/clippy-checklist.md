# Clippy Findings — Pre-Audit Triage

Tool: `cargo clippy --workspace --all-targets -- -D warnings`
Toolchain: Rust **1.90.0** (cycle-3 bump; was 1.85.0 in cycles 1–2)
Result: **0 errors, 0 warnings**.

The audit-toolkit-pass also runs the stricter

```bash
cargo clippy --workspace --all-features -- -D warnings -D clippy::all \
  -W clippy::arithmetic_side_effects \
  -W clippy::cast_possible_truncation \
  -W clippy::cast_sign_loss \
  -W clippy::cast_possible_wrap \
  -W clippy::checked_conversions
```

invocation defined in `audit/SVM/Makefile`. Result: **0 errors,
0 warnings** as of cycle 3 (no new lints surfaced from the 1.85 → 1.90
toolchain bump).

## Resolved findings

| Lint | Location | Disposition |
|---|---|---|
| `clippy::needless_return` | `oku_dollar::core::wrap` (two arms) | Fixed — converted `return Ok(x);` to bare `Ok(x)`. |
| `clippy::arithmetic_side_effects` | `lite_psm::helpers::oracle_relay::get_usdc_price` (`expo + precision_exp`, `(-shift) as u32`) | Fixed — `expo.checked_add(PRECISION_EXP)` + `shift.unsigned_abs()`. Audit-toolkit-pass. |
| `clippy::cast_sign_loss` | `lite_psm::helpers::oracle_relay::get_usdc_price` (`price as u128`, `shift as u32`, `(-shift) as u32`) | Fixed — `u128::try_from(price)` (sign-safe after `price > 0` assertion) + `shift.unsigned_abs()`. Audit-toolkit-pass. |
| `clippy::arithmetic_side_effects` | `oku_dollar::helpers::calculate_collateral_ratio` (`numerator / denominator`) | Fixed — `numerator.checked_div(denominator)`. The `denominator > 0` invariant is asserted in the preceding lines so the division can never trap. Audit-toolkit-pass. |

## Crate-wide suppressions (documented inline)

| Lint | Suppression scope | Rationale |
|---|---|---|
| `clippy::diverging_sub_expression` | `lite-psm`, `oku-dollar` | Fires on Anchor's `#[program]` macro expansion. Cannot be annotated inside generated code. Identical on every program in the workspace. |
| `unexpected_cfgs` | `lite-psm`, `oku-dollar` | `target_os = "solana"` cfg is emitted by `solana-program-entrypoint`'s panic-handler macro. The check-cfg machinery doesn't know about the BPF target. |
| `clippy::arbitrary_cpi` | `lite-psm`, `oku-dollar` | Existing F-02 disposition from an earlier review cycle. Every CPI target is constrained by Anchor's typed `Program<'info, T>` account system; the lint fires because the program ID is obtained at runtime from a typed account field rather than a hardcoded literal. |
| `clippy::too_many_arguments` | `lite-psm` (`initialize`) | F-13 disposition. 14 arguments map one-to-one to independent on-chain authority roles plus the `oracle_relay_pyth_program_owner` pubkey. Grouping into a struct would change the Anchor IDL wire format and break all existing callers. |

## Raw output

See `clippy-output.txt` for the full transcript:

```
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.13s
```

(Compile completed cleanly — no error, no warning lines.)
