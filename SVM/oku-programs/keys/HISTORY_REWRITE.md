# Secret Key History Rewrite

The six Solana keypairs originally committed under `keys/` were removed from
the HEAD commit in the SVM cleanup pass (commit `8789c70`). However, they
remain accessible in git history going back to commit `101494e`
("local scripts worked", 2026-02-17).

Assume all six keys are **compromised** for any actor with access to a clone
or remote of this repository before the rewrite is complete.

---

## Before you start

1. **Rotate any key that had real on-chain authority** (multisig membership,
   program upgrade authority, orchestrator role, fee recipient).
   These appear to be test/devnet keys only, but verify first.
2. Coordinate with all other developers who have local clones — they will need
   to reclone or rebase after the rewrite.
3. Make sure `git filter-repo` is installed:
   ```bash
   pip install git-filter-repo
   # or: brew install git-filter-repo
   ```
4. Run from the **repo root** (`contracts/`), not from `SVM/oku-programs/`.

---

## Step 1: Dry-run analysis

```bash
# From contracts/
git filter-repo --analyze
# Output written to .git/filter-repo/analysis/
# Review path-deleted-sizes.txt for the keys/ blobs
```

---

## Step 2: Rewrite history

```bash
# Remove all historical blobs under SVM/oku-programs/keys/ except the new
# README.md and .gitkeep that were added in the clean-up commit.
# The --invert-paths flag keeps everything EXCEPT the matched paths.

git filter-repo \
  --path 'SVM/oku-programs/keys/bridge-orchestrator.json' \
  --path 'SVM/oku-programs/keys/cold-multisig.json' \
  --path 'SVM/oku-programs/keys/devnet-authority.json' \
  --path 'SVM/oku-programs/keys/fee-recipient.json' \
  --path 'SVM/oku-programs/keys/orchestrator.json' \
  --path 'SVM/oku-programs/keys/warm-multisig.json' \
  --invert-paths \
  --force
```

---

## Step 3: Verify

```bash
# These should both produce empty output
git log --all --full-history -- 'SVM/oku-programs/keys/*.json' -- ':!SVM/oku-programs/keys/README.md' -- ':!SVM/oku-programs/keys/.gitkeep'

git rev-list --all \
  | xargs -n1 git ls-tree -r --name-only 2>/dev/null \
  | grep 'keys/.*\.json' \
  | grep -v README \
  | grep -v .gitkeep
```

Expected: no output from either command.

---

## Step 4: Push (force-with-lease)

```bash
# Verify your branch is ahead and correct before pushing
git log --oneline -5

# Force-push the rewritten history
git push --force-with-lease origin <your-branch>

# If pushing main:
#   NEVER force-push main without explicit team sign-off.
#   Coordinate via a PR from the rewritten branch instead.
```

---

## Step 5: Notify collaborators

All developers with local clones of the `contracts/` repository must either:

```bash
# Option A: Reclone from scratch (safest)
git clone <remote-url> contracts

# Option B: Fetch and hard-reset (if branch hasn't diverged locally)
git fetch origin
git reset --hard origin/<branch>
```

Any local clone that was fetched before the force-push still has the old
secret-containing history. Clones must be updated or discarded.

---

## Notes

- `git filter-repo --analyze` produces a `renames.txt` that may show the
  keys/ path under alternative historical names if files were ever moved. If
  so, add those paths to the `--path` list above.
- GitHub/GitLab may cache blobs even after force-push. Open a support ticket
  if you need the caching layer cleared for a public repository.
- After the rewrite, the `bridge-request.json` artifact that was committed
  (and removed in the cleanup) also persists in history. Add its path to the
  filter-repo invocation if you want to remove it too:
  ```
  --path 'SVM/oku-programs/bridge-request.json'
  ```
