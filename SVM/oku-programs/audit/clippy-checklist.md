# Clippy Findings — Pre-Audit Triage

Tool: `cargo clippy --workspace --all-targets -- -D warnings`
Result: **0 errors, 0 warnings**.

The two real findings discovered during the audit-prep run were fixed
in-source; the noise from macro-expansion was suppressed crate-wide
with documented rationale.

## Resolved findings

| Lint | Location | Disposition |
|---|---|---|
| `clippy::needless_return` | `oku_dollar::core::wrap` (two arms) | Fixed — converted `return Ok(x);` to bare `Ok(x)`. |

## Crate-wide suppressions (documented inline)

| Lint | Suppression scope | Rationale |
|---|---|---|
| `clippy::diverging_sub_expression` | `lite-psm`, `oku-dollar` | Fires on Anchor's `#[program]` macro expansion. Cannot be annotated inside generated code. Identical on every program in the workspace. |
| `unexpected_cfgs` | `lite-psm`, `oku-dollar` | `target_os = "solana"` cfg is emitted by `solana-program-entrypoint`'s panic-handler macro. The check-cfg machinery doesn't know about the BPF target. |
| `clippy::arbitrary_cpi` | `lite-psm`, `oku-dollar` | Existing F-02 disposition from an earlier review cycle. Every CPI target is constrained by Anchor's typed `Program<'info, T>` account system; the lint fires because the program ID is obtained at runtime from a typed account field rather than a hardcoded literal. |
| `clippy::too_many_arguments` | `lite-psm` (`initialize`) | F-13 disposition. 15 arguments maps one-to-one to independent on-chain authority roles. Grouping into a struct would change the Anchor IDL wire format and break all existing callers. |

## Raw output

See `clippy-output.txt` for the full transcript:

```
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.11s
```

(Compile completed cleanly — no error, no warning lines.)
