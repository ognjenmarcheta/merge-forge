import * as vscode from 'vscode';
import { listConflicted } from './git/conflicts';
import { detectOperation } from './git/repoContext';
import { readStages } from './git/stages';
import { MergePanel } from './panel/MergePanel';
import { ConflictCodeLensProvider } from './ui/codeLens';
import { activeRepoRoot, pickConflictedFile } from './ui/conflictPicker';
import { ContextKeys } from './ui/contextKeys';
import { ResolveHint } from './ui/resolveHint';

export function activate(context: vscode.ExtensionContext): void {
  const hint = new ResolveHint(context);
  let conflictedPaths = new Set<string>();
  const isConflicted = (editor: vscode.TextEditor | undefined): boolean =>
    editor !== undefined && conflictedPaths.has(editor.document.uri.fsPath);

  // ContextKeys owns the single .git/index watcher; every other affordance — the menus'
  // context keys, the CodeLens, the status-bar hint — follows its refreshes.
  const contextKeys = new ContextKeys(context, (absolutePaths) => {
    conflictedPaths = new Set(absolutePaths);
    codeLens.refresh();
    hint.update(vscode.window.activeTextEditor, isConflicted(vscode.window.activeTextEditor));
  });
  contextKeys.register();

  const refreshConflicted = (): Promise<void> => contextKeys.refresh();
  const codeLens = new ConflictCodeLensProvider((uri) => conflictedPaths.has(uri.fsPath));

  const open = async (uri?: vscode.Uri): Promise<void> => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showErrorMessage('Merge Forge: no file selected.');
      return;
    }
    await MergePanel.createOrShow(context, target);
    await contextKeys.refresh();
    await refreshConflicted();
  };

  const pickAndOpen = async (): Promise<void> => {
    const picked = await pickConflictedFile();
    if (picked) {
      await open(picked);
    }
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.commands.registerCommand('mergeForge.resolve', pickAndOpen),
    vscode.commands.registerCommand('mergeForge.pickConflicted', pickAndOpen),
    // The SCM view hands over a resource state rather than a Uri.
    vscode.commands.registerCommand(
      'mergeForge.resolveThis',
      (arg?: vscode.Uri | { resourceUri?: vscode.Uri }) =>
        open(arg instanceof vscode.Uri ? arg : arg?.resourceUri),
    ),
    vscode.commands.registerCommand('mergeForge.nextChange', () =>
      MergePanel.runOnActive('nextChange'),
    ),
    vscode.commands.registerCommand('mergeForge.prevChange', () =>
      MergePanel.runOnActive('prevChange'),
    ),
    vscode.commands.registerCommand('mergeForge.applyAllNonConflicting', () =>
      MergePanel.runOnActive('applyAllNonConflicting'),
    ),
    vscode.commands.registerCommand('mergeForge.diagnostics', () => showDiagnostics(context)),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      const conflicted = isConflicted(editor);
      hint.update(editor, conflicted);
      // Opening a conflicted file can jump straight into the merge editor, for people
      // who would rather never see the markers.
      if (editor && conflicted && readAutoOpen()) {
        await MergePanel.createOrShow(context, editor.document.uri);
      }
    }),
  );

  void refreshConflicted();
}

function readAutoOpen(): boolean {
  return vscode.workspace.getConfiguration('mergeForge').get<boolean>('autoOpenOnConflict', false);
}

/**
 * Dumps what the git layer sees for the current repo. This is how the git layer gets
 * checked by hand against a real conflicted repository.
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
