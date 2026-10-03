# Prebuilt Font Compression

Office owns HTTP font representations. Applications consume these artifacts
from a pinned Office commit without generating them during application builds.

Original fonts stay under `fonts/` and in `wasm-integrity-manifest.json`.
Compressed variants live under `font-compressed/v1/<original SHA256>.br|gzip`.
The deterministic `font-compressed/manifest.json` records schema `v1`, Brotli
quality 5, gzip level 6, each original digest, and each variant's path, compressed
size and compressed SHA256. Identical originals share variants.

Prepare after synchronizing/repairing/pruning assets and updating original hashes:

```sh
node scripts/hash-office-assets.mjs --asset-root .
node scripts/prepare-office-fonts.mjs --asset-root .
node scripts/verify-office-fonts.mjs --asset-root .
node --test tests/office-font-artifacts.test.mjs tests/chinese-fonts.test.mjs
```

Preparation verifies and reuses an existing complete pack. When a pack needs
repair or its original digest mappings change, preparation generates variants
sequentially, replaces files atomically and removes obsolete generated variants
only within `font-compressed/v1/`. Commit scripts, metadata and generated files
together. Verification never repairs artifacts: it checks original hashes,
compressed hashes/sizes, exact coverage and both decoded hashes. PR and release
CI verify committed artifacts; they do not regenerate compression outputs.

VDS performs metadata, coverage and size checks while packaging. It derives
runtime artifact filenames from original digests and retains original-byte
fallback in local HTTP requests. Compressed variants are intentionally excluded
from the original runtime manifest so session integrity checks do not add a
second scan of the compressed pack.

The current 269-font pack adds approximately 420 MiB. New binaries increase web
checkout cost and repository history; VDS core jobs must not initialize Office.
Font updates need new asset layers, while application-only changes can reuse the
independent Office layer. Measure checkout and packaging before claiming an
overall build-time improvement.

The first pack was generated and fully verified with Node.js 20.20.2 and its
bundled zlib/Brotli toolchain. Regeneration with a different toolchain may produce
different compressed bytes despite identical decoded fonts; CI validates the
committed artifact hashes and decoded content rather than byte-comparing against
regenerated output from arbitrary tools.
