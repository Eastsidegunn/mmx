# Contributing

Build with `cargo build`. Before a pull request, run:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build && node tests/editor_patch.mjs
cargo check --manifest-path wasm/Cargo.toml --target wasm32-wasip1
```

Install the `wasm32-wasip1` Rust target before the last command. The Node patch harness checks that browser edits preserve source details after a real mmx render.

Keep `mermaid-rs-renderer` pinned to `=0.3.1` unless a renderer update is deliberate, reviewed, and tested against the diagrams and diffs. In a PR, describe the behavior change, include a small `.mmd` reproduction when relevant, update docs or schema references for user-visible changes, and report the checks you ran. Contributions are licensed under [MIT](LICENSE).
