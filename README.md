# OFFICE Runtime Assets

This repository owns OFFICE runtime assets and governance scripts.
The main app repository consumes this repository as a git submodule.

## Quick commands

```bash
node scripts/sync-office-assets.mjs --source-root /path/to/upstream/vendor --asset-root .
node scripts/hash-office-assets.mjs --asset-root .
node scripts/prune-office-assets.mjs --asset-root . --dry-run
node scripts/verify-office-assets.mjs --asset-root . --en-only
```

## Documentation

- `docs/local-prepare-and-verify.md`: local preparation and verification flow
- `docs/runtime-assets-governance.md`: ownership boundary and governance policy
- `docs/security-checklist.md`: rollout and security checklist
- `docs/chinese-fonts.md`: Chinese font repair, PDF font handoff, and regression checks

## Governance boundary

- This repository owns asset preparation, hashing, pruning, and verification.
- The main repository owns integration logic and stale lock cleanup only.
