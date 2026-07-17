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

## 0.2.0 — unreleased

The full JetBrains merge flow around the editor:

- **Merge indicator cluster** in the status bar while a merge/rebase/cherry-pick is in
  progress: "⚠ Merging <branch> → <branch>" pill, `»` opens the Conflicts dialog, red `×`
  aborts the operation behind a confirmation.
- **Conflicts dialog**: directory-grouped file list with Yours/Theirs status columns,
  multi-select, Accept Yours / Accept Theirs / Merge…; auto-opens when conflicts appear
  (`mergeForge.autoShowConflicts`). Accept Yours/Theirs also resolves delete/modify
  conflicts, including correct side mapping during rebases.
- **Merge window**: JetBrains-style toolbar with whitespace-handling and highlight-mode
  dropdowns, "N changes. M conflicts." counter, "Changes from <branch>" pane headers,
  word-level diff highlights, Accept Left/Right whole-file buttons, Cancel/Apply footer.
- Undoing a whole-file accept reverses it in one step; changing whitespace handling
  recomputes changes behind an inline confirmation.
- The per-file status-bar hint and toast were replaced by the cluster + dialog.

### Polish round (0.2.0, continued)

- Keyboard-first flow: Alt+←/→ accept the current chunk's sides, every action
  auto-advances to the next pending change, and the editor opens on the first one.
- VS Code's codicon font replaces the unicode glyphs across toolbar and controls.
- Hovering a connector band highlights its chunk in all three panes; disabled
  bulk buttons explain why.
- Light-theme palette for every chunk surface (fills, hatches, bands, word
  highlights).
- Conflicts dialog: "N of M resolved" progress and full keyboard navigation
  (arrows, Enter to merge, Space to multi-select).

## 0.3.0 — unreleased

AI conflict explanations and the remaining JetBrains-parity details:

- **✦ Explain conflicts with AI**: a toolbar button streams a per-conflict explanation
  (what each side changed, why they collide, a suggested resolution) into a drawer above
  the panes. Two backends, auto-detected: the editor's own Language Model API (VS Code
  with Copilot — zero configuration) or a direct Anthropic API call. Cursor does not
  expose its models to extensions, so there set a key once via
  "Merge Forge: Set Anthropic API Key" (stored in SecretStorage; model configurable via
  `mergeForge.ai.model`, default `claude-opus-4-8`).
- **Delete/modify conflicts** get a real dialog: Resolve…/Enter/double-click on such a
  row asks "deleted in X, modified in Y — Keep Modified File / Delete File". Status
  columns now also show the correct side mid-rebase.
- **Status pill live count**: "Merging: 3 conflicts" → "Merging: all resolved", updated
  as files are resolved; the branch pair lives in the tooltip.
- **Base line numbers** in the result pane: the original line number next to the current
  one, `·` where a chunk replaced the base text — JetBrains' dual margin.
- **File-type icons** and full-path tooltips in the Conflicts dialog.
- Requires VS Code/Cursor ≥ 1.90.
