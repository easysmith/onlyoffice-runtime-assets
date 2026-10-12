# Runtime Asset Security Checklist

Use this checklist before shipping a new runtime asset revision.

- [ ] Run `node scripts/sync-office-assets.mjs --source-root <dir> --asset-root .`
- [ ] Run `node scripts/hash-office-assets.mjs --asset-root .`
- [ ] Run `node scripts/prune-office-assets.mjs --asset-root . --dry-run`
- [ ] Run `node scripts/verify-office-assets.mjs --asset-root . --locales en,zh --help-locales en --monaco-locales en,zh-cn`
- [ ] Review manifest diff in `wasm-integrity-manifest.json`
- [ ] Confirm the manifest only covers core runtime assets, not help/docs/example payloads
- [ ] Ensure push-based governance workflow passes on `runtime-en`
- [ ] Update main repository submodule pointer only after checks pass
