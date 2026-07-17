import { basename } from 'node:path';
import * as vscode from 'vscode';

/**
 * A hard-to-miss "Resolve in Merge Forge" affordance for conflicted files.
 *
 * The extension API offers no way to float a button over a text editor, so this is the
 * closest the platform allows: a prominent status-bar button while a conflicted file is
 * active, plus a toast with an action button the first time each conflicted file is
 * opened — the toast is the only floating clickable surface an extension gets.
 * Status-bar backgrounds are limited to the theme's warning/error colours; green is not
 * an option the API offers.
 */
export class ResolveHint {
  private readonly item: vscode.StatusBarItem;
  /** Files already toasted this session — one nudge per file, not one per focus. */
  private readonly prompted = new Set<string>();

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_000);
    this.item.text = '$(git-merge) Resolve in Merge Forge';
    this.item.tooltip = 'Open the three-pane merge editor for this file';
    this.item.command = 'mergeForge.resolveThis';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    context.subscriptions.push(this.item);
  }

  /** Shows or hides the affordance to match the active editor. */
  update(editor: vscode.TextEditor | undefined, isConflicted: boolean): void {
    if (!editor || !isConflicted) {
      this.item.hide();
      return;
    }
    this.item.show();

    const uri = editor.document.uri;
    const key = uri.toString();
    if (this.prompted.has(key)) {
      return;
    }
    this.prompted.add(key);
    void vscode.window
      .showInformationMessage(
        `"${basename(uri.fsPath)}" has merge conflicts.`,
        'Resolve in Merge Forge',
      )
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('mergeForge.resolveThis', uri);
        }
      });
  }
}
