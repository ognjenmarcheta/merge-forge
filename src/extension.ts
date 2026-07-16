import * as vscode from 'vscode';
import { MergePanel } from './panel/MergePanel';
import { activeRepoRoot, pickConflictedFile } from './ui/conflictPicker';
import { listConflicted } from './git/conflicts';
import { detectOperation } from './git/repoContext';
import { readStages } from './git/stages';

export function activate(context: vscode.ExtensionContext): void {
  const open = async (uri?: vscode.Uri): Promise<void> => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showErrorMessage('Merge Forge: no file selected.');
      return;
    }
    await MergePanel.createOrShow(context, target);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('mergeForge.resolve', async () => {
      const picked = await pickConflictedFile();
      if (picked) {
        await MergePanel.createOrShow(context, picked);
      }
    }),
    vscode.commands.registerCommand('mergeForge.resolveThis', open),
    vscode.commands.registerCommand('mergeForge.pickConflicted', async () => {
      const picked = await pickConflictedFile();
      if (picked) {
        await MergePanel.createOrShow(context, picked);
      }
    }),
    vscode.commands.registerCommand('mergeForge.diagnostics', () => showDiagnostics(context)),
  );
}

/**
 * Dumps what the git layer sees for the current repo into an output channel.
 * This is how the git layer is verified against a real conflicted repo by hand.
 */
async function showDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Merge Forge');
  context.subscriptions.push(channel);
  channel.show(true);

  const repoRoot = await activeRepoRoot();
  if (!repoRoot) {
    channel.appendLine('No git repository found.');
    return;
  }
  const [conflicted, operation] = await Promise.all([
    listConflicted(repoRoot),
    detectOperation(repoRoot),
  ]);
  channel.appendLine(`repo:      ${repoRoot}`);
  channel.appendLine(
    `operation: ${operation.kind} (swapPresentation=${operation.swapPresentation})`,
  );
  channel.appendLine(`conflicted (${conflicted.length}):`);
  for (const path of conflicted) {
    const stages = await readStages(repoRoot, path).catch(() => undefined);
    const present = stages
      ? (['base', 'ours', 'theirs'] as const).filter((name) => stages[name]).join(', ')
      : 'unreadable';
    channel.appendLine(`  ${path} — stages: ${present}`);
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
