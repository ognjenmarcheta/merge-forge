import * as vscode from 'vscode';
import { MergePanel } from './panel/MergePanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mergeForge.resolve', (uri?: vscode.Uri) => {
      return MergePanel.createOrShow(context, uri ?? vscode.window.activeTextEditor?.document.uri);
    }),
    vscode.commands.registerCommand('mergeForge.resolveThis', (uri?: vscode.Uri) => {
      return MergePanel.createOrShow(context, uri ?? vscode.window.activeTextEditor?.document.uri);
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
