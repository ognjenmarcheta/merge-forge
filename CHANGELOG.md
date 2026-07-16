# Changelog

## 0.1.0 — unreleased

First working version: a JetBrains-style three-pane merge conflict resolver.

- Three scroll-synced panes (yours / result / theirs) with syntax highlighting, the result
  seeded from the base revision and fully editable.
- Diff3 chunking verified against `git merge-file` — agrees with git about what conflicts,
  and matches git's output byte-for-byte where git merges cleanly.
- Per-chunk `»` / `«` / `×` gutter buttons with connector bands; conflicts can take one side
  or both.
- Apply All Non-Conflicting Changes (all, or from one side), Magic Resolve for both-added
  chunks, F7 / Shift+F7 navigation, live remaining-changes counter.
- Apply writes the result and stages it; unresolved conflicts prompt first. Abort leaves the
  conflicted file untouched.
- Line endings, BOMs, and missing trailing newlines round-trip; CRLF/LF disagreements are
  surfaced with a choice.
- Handles both-added files, rebase/cherry-pick stage swapping, and delete/modify conflicts.
- Entry points: editor title button, CodeLens, Explorer and SCM context menus, command
  palette, and an optional auto-open setting.
