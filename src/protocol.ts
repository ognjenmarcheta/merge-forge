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

export type HostToWebviewMessage =
  | { type: 'init'; payload: InitPayload }
  | { type: 'runAction'; action: MergeAction }
  | { type: 'applyResult'; ok: boolean; error?: string };

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
  | { type: 'log'; level: 'warn' | 'error'; message: string };
