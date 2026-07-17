import { join } from 'node:path';
import * as vscode from 'vscode';
import { detectOperation, getMergeBranches } from '../git/repoContext';
import { acceptSide, listConflictStatuses } from '../git/resolveOps';
import type { ConflictsData, ConflictsToHostMessage, HostToConflictsMessage } from '../protocol';
import { getConflictsHtml } from './html';

/**
 * The Conflicts dialog host — JetBrains' file-list modal as a singleton webview tab.
 * It lists conflicted files with per-side statuses and runs whole-file resolutions;
 * per-chunk work is handed off to the three-pane MergePanel via `mergeForge.resolveThis`.
 */
export class ConflictsPanel {
  private static current: ConflictsPanel | undefined;

  static show(context: vscode.ExtensionContext, repoRoot: string): void {
    if (ConflictsPanel.current) {
      ConflictsPanel.current.repoRoot = repoRoot;
      ConflictsPanel.current.panel.reveal();
      void ConflictsPanel.current.push();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'mergeForge.conflicts',
      'Conflicts',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    ConflictsPanel.current = new ConflictsPanel(panel, context, repoRoot);
  }

  /** Live-updates the open dialog (if any) — called from the .git/index watcher. */
  static refresh(): void {
    void ConflictsPanel.current?.push();
  }

  static get isOpen(): boolean {
    return ConflictsPanel.current !== undefined;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private repoRoot: string,
  ) {
    this.panel.webview.html = getConflictsHtml(this.panel.webview, context.extensionUri);
    this.panel.onDidDispose(() => {
      ConflictsPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: ConflictsToHostMessage) =>
      this.onMessage(message),
    );
  }

  private post(message: HostToConflictsMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async push(): Promise<void> {
    const [files, branches, operation] = await Promise.all([
      listConflictStatuses(this.repoRoot),
      getMergeBranches(this.repoRoot),
      detectOperation(this.repoRoot),
    ]);
    const payload: ConflictsData = {
      files: files.map((file) => ({
        ...file,
        // A side that deleted the file leaves nothing to show in three panes.
        mergeable: file.yours !== 'Deleted' && file.theirs !== 'Deleted',
      })),
      branches,
      operation: operation.kind,
    };
    this.post({ type: 'conflicts', payload });
  }

  private async onMessage(message: ConflictsToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.push();
        break;
      case 'acceptSide': {
        const operation = await detectOperation(this.repoRoot);
        try {
          await acceptSide(
            this.repoRoot,
            message.payload.paths,
            message.payload.side,
            operation.swapPresentation,
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Merge Forge: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // The index watcher will also fire, but pushing now keeps the dialog snappy.
        await this.push();
        break;
      }
      case 'openMerge':
        await vscode.commands.executeCommand(
          'mergeForge.resolveThis',
          vscode.Uri.file(join(this.repoRoot, message.payload.path)),
        );
        break;
      case 'close':
        this.panel.dispose();
        break;
    }
  }
}
