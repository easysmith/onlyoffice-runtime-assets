# Local Prepare and Verify

Use this flow when updating OFFICE runtime assets in this repository.

## 1) Sync assets from upstream source

```bash
node scripts/sync-office-assets.mjs \
  --source-root /path/to/upstream/vendor \
  --asset-root .
```

Sync also repairs the Chinese font mappings, fallback ranges, and WASM PDF font
handoff. For existing assets, run `node scripts/repair-chinese-fonts.mjs --asset-root .`
before hashing. See [Chinese font compatibility](chinese-fonts.md).

## 2) Rebuild integrity manifest

```bash
node scripts/hash-office-assets.mjs --asset-root .
```

The manifest intentionally tracks core runtime assets only:
- executable/runtime bundles such as `js`, `css`, `wasm`, `json`, and runtime `.bin` data
- root runtime files such as `document_editor_service_worker.js`, `plugins.json`, and `themes.json`
- all font payloads, including extensionless numeric files under `fonts/`

It does not track bulky non-core content such as `help/` docs, screenshots, examples, or sourcemaps.

## 3) Prune untracked or stale files

```bash
node scripts/prune-office-assets.mjs --asset-root . --dry-run
node scripts/prune-office-assets.mjs --asset-root .
```

## 4) Verify runtime package constraints

```bash
node scripts/verify-office-assets.mjs --asset-root . --en-only
node --test tests/chinese-fonts.test.mjs
```

## 5) Commit and publish

- Commit script and asset changes in this repository first.
- Update the submodule gitlink in the main app repository after approval.
