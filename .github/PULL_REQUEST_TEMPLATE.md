## What this changes

<!-- What behaviour differs after this, and why it is worth changing. -->

## How it was verified

<!-- Which checks were run, and anything exercised by hand. The default suite
     must not need a live AWS account; scripts/local-s3.sh runs a local server
     for end-to-end checks. -->

- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- [ ] `cargo test --workspace --all-features`
- [ ] `npm --prefix extension run check && npm --prefix extension test`

## Boundaries

<!-- Delete any that do not apply. -->

- [ ] AWS access stays read-only: no uploads, deletes, or notification config
- [ ] Behaviour lives in Rust; TypeScript only integrates and presents
- [ ] Protocol changes are additive and camel-case, and `docs/json-rpc.md` is updated
- [ ] New per-watcher state is bounded, and long work is cancellable
