import * as vscode from 'vscode';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../protocol';
import { getWebviewHtml } from './html';

/**
 * One merge panel per conflicted file. Owns the webview lifecycle and the
 * message bridge; the merge UI itself lives entirely in the webview bundle.
 */
export class MergePanel {
  private static readonly panels = new Map<string, MergePanel>();

  static async createOrShow(
    context: vscode.ExtensionContext,
    uri: vscode.Uri | undefined,
  ): Promise<void> {
    const key = uri?.toString() ?? '__untitled__';
    const existing = MergePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'mergeForge.mergeEditor',
      uri ? `Merge: ${uri.path.split('/').pop() ?? uri.path}` : 'Merge Forge',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    MergePanel.panels.set(key, new MergePanel(panel, context, key, uri));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly key: string,
    readonly uri: vscode.Uri | undefined,
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
        // M1 scaffold: echo a placeholder init payload to prove the round-trip.
        this.post({
          type: 'init',
          payload: {
            filePath: this.uri?.fsPath ?? '(no file)',
            languageId: 'plaintext',
            left: 'hello from LEFT',
            base: 'hello from BASE',
            right: 'hello from RIGHT',
            labels: { left: 'Yours', right: 'Theirs' },
            eol: { left: 'lf', base: 'lf', right: 'lf', conflict: false, suggested: 'lf' },
            settings: { autoApplyNonConflicting: false },
          },
        });
        break;
      case 'abort':
        this.panel.dispose();
        break;
      case 'log':
        console[message.level === 'error' ? 'error' : 'warn'](`[merge-forge] ${message.message}`);
        break;
      case 'state':
      case 'apply':
        // Implemented in later milestones.
        break;
    }
  }
}
