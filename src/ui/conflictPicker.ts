import { join } from 'node:path';
import * as vscode from 'vscode';
import { listConflicted } from '../git/conflicts';
import { findRepoRoot } from '../git/repoContext';

/** The repo root for the current workspace, or undefined when there isn't one. */
export async function activeRepoRoot(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    const root = await findRepoRoot(active.fsPath);
    if (root) {
      return root;
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = await findRepoRoot(folder.uri.fsPath);
    if (root) {
      return root;
    }
  }
  return undefined;
}

/** Shows every conflicted file and resolves to the one picked, if any. */
export async function pickConflictedFile(): Promise<vscode.Uri | undefined> {
  const repoRoot = await activeRepoRoot();
  if (!repoRoot) {
    void vscode.window.showErrorMessage('Merge Forge: no git repository found in this workspace.');
    return undefined;
  }
  const conflicted = await listConflicted(repoRoot);
  if (conflicted.length === 0) {
    void vscode.window.showInformationMessage('Merge Forge: no conflicted files.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(conflicted, {
    title: 'Merge Forge: conflicted files',
    placeHolder: 'Select a file to resolve',
  });
  return picked ? vscode.Uri.file(join(repoRoot, picked)) : undefined;
}
