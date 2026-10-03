# Runtime Assets Governance

## Ownership model

This repository is the source of truth for runtime assets and governance
artifacts.

Owned in this repository:
- `scripts/sync-office-assets.mjs`
- `scripts/hash-office-assets.mjs`
- `scripts/prune-office-assets.mjs`
- `scripts/verify-office-assets.mjs`
- Font compression generation and verification scripts and `font-compressed/`
- runtime asset governance docs and workflow

Owned in the main app repository:
- OFFICE runtime integration code
- stale lock cleanup command surface
- index style docs that link back to this repository

## Branch and CI policy

- Governance checks run on push events for branch `runtime-en`.
- Pull requests to `runtime-en` verify committed compression artifacts too.
- Any runtime asset update must pass prune, hash, and verify checks before
  publishing a new submodule pointer in the main repository.
