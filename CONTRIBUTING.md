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

npm --prefix extension ci
npm --prefix extension run check
npm --prefix extension test
npm --prefix extension run compile
```

Packaging additionally requires a matching staged backend; see
`extension/bin/README.md` and pass `--target <platform-architecture>`.

Tests must not depend on production AWS access. Put AWS behavior behind the
core object-store abstraction and test with fakes. If you perform an explicit
integration test, use a dedicated read-only test account and prefix.

Protocol changes need matching updates in `docs/json-rpc.md` and should be
additive whenever possible. Avoid logging full SDK debug structures because
they can contain sensitive operational context.
