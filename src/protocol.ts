/**
 * Message protocol between the extension host and the webview.
 * This module must stay free of `vscode` and DOM imports — it is bundled into both sides.
 */

export type Eol = 'lf' | 'crlf';

export interface EolInfo {
  left: Eol;
  base: Eol;
  right: Eol;
  /** True when the three versions disagree on line endings. */
  conflict: boolean;
  /** The EOL the result should default to. */
  suggested: Eol;
}

export interface InitPayload {
  /** Workspace-relative path, for display. */
  filePath: string;
  /** Monaco language id derived from the file name. */
  languageId: string;
  /** Contents are always \n-normalized; EOL is restored on apply. */
  left: string;
  base: string;
  right: string;
  labels: { left: string; right: string };
  eol: EolInfo;
  settings: { autoApplyNonConflicting: boolean };
}

export type MergeAction = 'nextChange' | 'prevChange' | 'applyAllNonConflicting' | 'requestApply';

// --- AI explain -------------------------------------------------------------------

export interface ExplainConflict {
  /** 1-based position among the file's conflicts, for "Conflict N" headings. */
  index: number;
  baseText: string;
  leftText: string;
  rightText: string;
}

export interface ExplainRequest {
  filePath: string;
  languageId: string;
  labels: { left: string; right: string };
  conflicts: ExplainConflict[];
}

export type HostToWebviewMessage =
  | { type: 'init'; payload: InitPayload }
  | { type: 'runAction'; action: MergeAction }
  | { type: 'applyResult'; ok: boolean; error?: string }
  | { type: 'explainDelta'; text: string }
  | { type: 'explainDone' }
  | { type: 'explainError'; message: string; unconfigured?: boolean };

export interface StatePayload {
  totalChunks: number;
  unresolvedConflicts: number;
  /** Unresolved chunks of any kind (drives the "N changes remaining" counter). */
  pendingChanges: number;
  /** True once the center document differs from its initial content. */
  dirty: boolean;
}

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'state'; payload: StatePayload }
  | { type: 'apply'; payload: { content: string; eol: Eol } }
  | { type: 'abort' }
  | { type: 'explain'; payload: ExplainRequest }
  | { type: 'explainCancel' }
  | { type: 'openAiSetup' }
  | { type: 'log'; level: 'warn' | 'error'; message: string };

// --- Conflicts dialog (the file-list webview, separate bundle) ---------------------

export interface ConflictFileEntry {
  path: string;
  yours: string;
  theirs: string;
  /** False for delete/modify rows: no three-pane view exists, Accept buttons resolve. */
  mergeable: boolean;
}

export interface ConflictsData {
  files: ConflictFileEntry[];
  branches: { yours: string; theirs: string };
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'unknown';
  /** Most files seen conflicted this operation — the denominator for "2 of 5 resolved". */
  totalAtStart: number;
}

export type HostToConflictsMessage = { type: 'conflicts'; payload: ConflictsData };

export type ConflictsToHostMessage =
  | { type: 'ready' }
  | { type: 'acceptSide'; payload: { paths: string[]; side: 'yours' | 'theirs' } }
  | { type: 'openMerge'; payload: { path: string } }
  | { type: 'resolveDeleteModify'; payload: { path: string } }
  | { type: 'close' };
