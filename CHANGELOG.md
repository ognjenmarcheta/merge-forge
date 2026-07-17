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

## 0.4.0 — unreleased

Multi-provider AI backends:

- **"Explain conflicts with AI" now works with five backends**: Anthropic
  (claude-opus-4-8), OpenAI (gpt-5.6-sol), DeepSeek (deepseek-v4-flash), Kimi/Moonshot
  (kimi-k2.6), and any Custom OpenAI-compatible endpoint — OpenRouter, local Ollama
  (`http://localhost:11434/v1`, no key needed), corporate proxies. The editor's own
  Language Model API (VS Code + Copilot) is still tried first, zero-config.
- **One guided command** — "Merge Forge: Set AI Provider & API Key" — picks the
  provider, takes the key (stored per provider in SecretStorage), and activates it.
  "Clear AI API Keys" removes stored keys selectively. An Anthropic key stored by
  0.3.0 keeps working without reconfiguration.
- `mergeForge.ai.model` now defaults to `"auto"` (the active provider's default;
  any explicit value overrides). New: `mergeForge.ai.provider`,
  `mergeForge.ai.customBaseUrl`, `mergeForge.ai.customModel`.
- Streaming now runs on the Vercel AI SDK — one code path for every provider, with
  the OpenAI-compatible protocol covered by a local stub test. Note: DeepSeek's old
  `deepseek-chat` alias retires 2026-07-24; merge-forge uses the V4 IDs already.

## 0.4.1 — unreleased

- The explain drawer header now shows its scope — "✦ AI explanation — N unresolved
  conflicts" — so a single section on a single-conflict file no longer reads as an
  early stop (already-resolved conflicts are intentionally not re-explained).
- The prompt now demands exactly one section per conflict, and the request carries an
  explicit 16K output-token cap; when a response still hits the cap, the drawer shows
  "⚠ Output limit reached" instead of pretending the explanation was complete.
