# MergeForge

A JetBrains/WebStorm-style **three-pane visual merge conflict resolver** for VS Code and Cursor.

- **Left pane** — your local version (read-only)
- **Center pane** — the merge result, seeded from the common ancestor (base), fully editable
- **Right pane** — the incoming version (read-only)

Accept chunks with `»` / `«`, discard with `×`, apply all non-conflicting changes in one click,
magic-resolve simple conflicts, then **Apply** to write the result and mark the file resolved
(`git add`) — exactly the workflow you know from IntelliJ/WebStorm.

## Status

Work in progress — pre-release.

## Development

```sh
pnpm install
pnpm run watch     # incremental builds (extension host + webview + Monaco worker)
# press F5 in VS Code to launch the Extension Development Host
pnpm test          # unit tests for the merge engine
node scripts/make-conflict-repo.mjs   # throwaway git repo with real conflicts
```

## License

MIT
