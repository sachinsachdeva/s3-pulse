# S3 Pulse repository guidance

S3 Pulse answers **“Is my feed healthy?”** It is not a generic S3 explorer.

## Non-negotiable boundaries

- Put AWS access, polling, watcher state, statistics, history, and downloads in
  Rust. TypeScript owns only VS Code integration and presentation.
- Treat AWS as read-only. Never upload/delete objects or alter bucket
  notification configuration.
- Use normal AWS credential discovery. Never store or log credentials.
- Do not require a live AWS account in the default test suite. Prefer traits,
  fakes, fixtures, and protocol-level tests.
- Keep stdout protocol-only during `serve --stdio`; write diagnostics to stderr.
- Bound all per-watcher history and make long-running work cancellable.
- Keep JSON representations camel-case and evolve the protocol additively.

## Definition of done for a change

Run the checks relevant to the edited areas:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
npm --prefix extension run check
npm --prefix extension test
npm --prefix extension run compile
```

For release packaging, stage exactly one native backend and run
`npm --prefix extension run package -- --target <platform-architecture>`.

Update `docs/json-rpc.md` for protocol changes. Errors exposed to users should
distinguish expired/missing credentials, access denied, network failures, and
invalid S3 targets where possible.
