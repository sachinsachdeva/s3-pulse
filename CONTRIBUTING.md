# Contributing

Thanks for helping improve S3 Pulse. Keep changes focused on feed monitoring and
operational health; generic S3-management features are deliberately outside the
product's core.

## Local checks

Rust requires 1.94.1 or newer. The extension requires Node.js 22 or later.

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo deny check advisories licenses bans sources

npm --prefix extension ci
npm --prefix extension run check
npm --prefix extension test
npm --prefix extension run compile
```

`cargo deny` also gates CI; install it with `cargo install cargo-deny`. It
enforces the licence allow-list and the advisory database in `deny.toml`.

Packaging requires exactly one staged backend, which
`npm --prefix extension run stage-backend -- --release --target <platform-architecture>`
places for you; see `extension/bin/README.md`. Package with the same target.

Tests must not depend on production AWS access. Put AWS behavior behind the
core object-store abstraction and test with fakes. If you perform an explicit
integration test, use a dedicated read-only test account and prefix.

Protocol changes need matching updates in `docs/json-rpc.md` and should be
additive whenever possible. Avoid logging full SDK debug structures because
they can contain sensitive operational context.
