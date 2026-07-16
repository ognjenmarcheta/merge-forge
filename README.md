# MergeForge

A JetBrains/WebStorm-style **three-pane visual merge conflict resolver** for VS Code and Cursor.

VS Code's built-in merge editor stacks _Incoming_ and _Current_ above the result. MergeForge
uses the layout JetBrains users know instead: your version, the result, and theirs, side by
side and scrolled together.

|            |                                                                |
| ---------- | -------------------------------------------------------------- |
| **Left**   | your local version — read-only                                 |
| **Center** | the result, seeded from the **base** revision — fully editable |
| **Right**  | the incoming version — read-only                               |

## What it does

- **`»` / `«` to accept, `×` to ignore** — per-chunk buttons in the gutter strips, with
  connector bands linking each change to its place in the result. On a conflict you can take
  one side, or both in the order you click them.
- **Apply All Non-Conflicting Changes** — resolves everything only one side touched, leaving
  the real decisions to you. Also available from one side only.
- **Magic Resolve** — settles conflicts where both sides simply _added_ lines by keeping
  both. It deliberately refuses genuine rewrites, where guessing would drop someone's work.
- **Edit the result freely** — hand-write a blend of both sides; a chunk you edit counts as
  decided.
- **JetBrains colours** — blue modified, green added, gray deleted, red conflict.
- **F7 / Shift+F7** to step through changes, with a live "N of M remaining" counter.
- **Apply** writes the result and runs `git add`, so the file is marked resolved. Applying
  with conflicts still open asks first. **Abort** leaves the conflicted file untouched.
- **Line endings and BOMs survive.** If the sides disagree on CRLF vs LF you pick the result's
  ending; a missing trailing newline stays missing.

## Handling of awkward conflicts

- **Both sides added the file** (no common ancestor) — merges against an empty base, so each
  side's lines are insertions rather than one file-sized conflict.
- **Rebase and cherry-pick** — git swaps the meaning of its stage 2/3 during a rebase.
  MergeForge swaps them back, so the left pane is always _your_ work.
- **Deleted on one side, modified on the other** — there is no sensible three-pane view, so
  MergeForge says so and points you at the Source Control view rather than showing empty panes.

## Correctness

The chunking engine is checked against real `git merge-file` output: on generated conflict
cases it must agree with git about _what conflicts_, and where git merges cleanly its
auto-merge output must match git **byte for byte**. Line endings, BOMs, and missing trailing
newlines are covered by tests against real conflicted repositories.

## Getting started

Open a file with conflicts and use any of:

- the editor title bar button, or the **Resolve in Merge Forge** CodeLens above a conflict
- right-click the file in the Explorer or Source Control view
- **Merge Forge: Resolve Conflicts in File…** from the command palette

## Settings

| Setting                              | Default  | Description                                                           |
| ------------------------------------ | -------- | --------------------------------------------------------------------- |
| `mergeForge.autoOpenOnConflict`      | `false`  | Open the merge editor automatically when you open a conflicted file.  |
| `mergeForge.lineEnding`              | `"auto"` | Result line ending when the sides disagree. `auto` follows your side. |
| `mergeForge.autoApplyNonConflicting` | `false`  | Apply all non-conflicting changes as soon as the editor opens.        |

## Development

```sh
pnpm install
pnpm run watch     # extension host + webview + Monaco worker
# press F5 to launch the Extension Development Host

pnpm test          # unit, git-parity, and end-to-end tests
pnpm run check     # format + lint + typecheck + test
pnpm run package   # build a .vsix

node scripts/make-conflict-repo.mjs            # throwaway repo with every conflict shape
node scripts/make-conflict-repo.mjs --rebase   # ...stopped mid-rebase instead
```

To iterate on the UI without launching an editor, serve the repo and open `dev/harness.html`
— it drives the real webview bundle in a plain browser with a stubbed host.

## License

MIT
