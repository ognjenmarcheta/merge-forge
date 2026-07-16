import { relative } from 'node:path';
import * as vscode from 'vscode';
import { loadMergeInputs, type UnsupportedReason } from '../git/loadMerge';
import { findRepoRoot } from '../git/repoContext';
import type { EolSetting } from '../merge/lineEndings';
import type {
  HostToWebviewMessage,
  InitPayload,
  StatePayload,
  WebviewToHostMessage,
} from '../protocol';
import { getWebviewHtml } from './html';

/**
 * One merge panel per conflicted file. Owns the webview lifecycle, loads the three
 * versions from git, and bridges messages; the merge UI itself lives in the webview.
 */
export class MergePanel {
  private static readonly panels = new Map<string, MergePanel>();

  private latestState: StatePayload | undefined;

  static async createOrShow(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const existing = MergePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const repoRoot = await findRepoRoot(uri.fsPath);
    if (!repoRoot) {
      void vscode.window.showErrorMessage('Merge Forge: this file is not inside a git repository.');
      return;
    }
    const relativePath = relative(repoRoot, uri.fsPath);

    let inputs: Awaited<ReturnType<typeof loadMergeInputs>>;
    try {
      inputs = await loadMergeInputs(repoRoot, relativePath, readEolSetting());
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Merge Forge: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (inputs.unsupported) {
      await showUnsupported(inputs.unsupported, relativePath);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mergeForge.mergeEditor',
      `Merge: ${relativePath}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The center pane holds unsaved work; rebuilding it on every tab switch would lose it.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );

    const payload = {
      ...inputs.payload,
      filePath: relativePath,
      languageId: await detectLanguageId(uri),
      settings: { autoApplyNonConflicting: readAutoApply() },
    };
    MergePanel.panels.set(key, new MergePanel(panel, context, key, uri, payload));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly key: string,
    readonly uri: vscode.Uri,
    private readonly payload: InitPayload,
  ) {
    this.panel.webview.html = getWebviewHtml(this.panel.webview, context.extensionUri);
    this.panel.onDidDispose(() => MergePanel.panels.delete(this.key));
    this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) =>
      this.onMessage(message),
    );
  }

  private post(message: HostToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private onMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'init', payload: this.payload });
        break;
      case 'state':
        this.latestState = message.payload;
        break;
      case 'abort':
        this.panel.dispose();
        break;
      case 'log':
        console[message.level === 'error' ? 'error' : 'warn'](`[merge-forge] ${message.message}`);
        break;
      case 'apply':
        // Wired up in M8, once the result pane can produce a final document.
        void this.latestState;
        break;
    }
  }
}

function readEolSetting(): EolSetting {
  const value = vscode.workspace.getConfiguration('mergeForge').get<string>('lineEnding', 'auto');
  return value === 'lf' || value === 'crlf' ? value : 'auto';
}

function readAutoApply(): boolean {
  return vscode.workspace
    .getConfiguration('mergeForge')
    .get<boolean>('autoApplyNonConflicting', false);
}

/** Reuses VS Code's own filename→language mapping, which Monaco's ids line up with. */
async function detectLanguageId(uri: vscode.Uri): Promise<string> {
  try {
    return (await vscode.workspace.openTextDocument(uri)).languageId;
  } catch {
    return 'plaintext';
  }
}

/**
 * A delete/modify conflict has nothing to show in three panes — one side has no file at
 * all — so offer the only two decisions that exist instead of an empty editor.
 */
async function showUnsupported(reason: UnsupportedReason, relativePath: string): Promise<void> {
  const deletedBy = reason === 'deletedByThem' ? 'the incoming branch' : 'your branch';
  void vscode.window.showWarningMessage(
    `Merge Forge: "${relativePath}" was deleted by ${deletedBy} and modified on the other side. ` +
      'Resolve it from the Source Control view by keeping or deleting the file.',
  );
}
