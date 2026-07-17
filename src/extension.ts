import * as vscode from 'vscode';
import { API_KEY_SECRET } from './ai/provider';
import { listConflicted } from './git/conflicts';
import { detectOperation } from './git/repoContext';
import { readStages } from './git/stages';
import { ConflictsPanel } from './panel/ConflictsPanel';
import { MergePanel } from './panel/MergePanel';
import { ConflictCodeLensProvider } from './ui/codeLens';
import { activeRepoRoot } from './ui/conflictPicker';
import { ContextKeys } from './ui/contextKeys';
import { confirmAndAbort, MergeStatusCluster } from './ui/mergeStatus';

export function activate(context: vscode.ExtensionContext): void {
  const cluster = new MergeStatusCluster(context);
  let conflictedPaths = new Set<string>();
  let knownRepoRoot: string | undefined;

  // ContextKeys owns the single .git/index watcher; the menus' context keys, the
  // CodeLens, the status cluster, and the Conflicts dialog all follow its refreshes.
  const contextKeys = new ContextKeys(context, (absolutePaths, repoRoot) => {
    const hadConflicts = conflictedPaths.size > 0;
    conflictedPaths = new Set(absolutePaths);
    knownRepoRoot = repoRoot;
    codeLens.refresh();
    void cluster.refresh(repoRoot, conflictedPaths.size);
    ConflictsPanel.refresh();
    // JetBrains pops its Conflicts dialog the moment a merge hits conflicts.
    if (!hadConflicts && conflictedPaths.size > 0 && repoRoot && readAutoShow()) {
      ConflictsPanel.show(context, repoRoot);
    }
  });
  contextKeys.register();

  const codeLens = new ConflictCodeLensProvider((uri) => conflictedPaths.has(uri.fsPath));

  const showConflicts = async (): Promise<void> => {
    const repoRoot = knownRepoRoot ?? (await activeRepoRoot());
    if (!repoRoot) {
      void vscode.window.showErrorMessage('Merge Forge: no git repository found.');
      return;
    }
    ConflictsPanel.show(context, repoRoot);
  };

  const open = async (uri?: vscode.Uri): Promise<void> => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showErrorMessage('Merge Forge: no file selected.');
      return;
    }
    await MergePanel.createOrShow(context, target);
    await contextKeys.refresh();
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.commands.registerCommand('mergeForge.showConflicts', showConflicts),
    // Both older entry points now lead to the dialog too — one flow, one list.
    vscode.commands.registerCommand('mergeForge.resolve', showConflicts),
    vscode.commands.registerCommand('mergeForge.pickConflicted', showConflicts),
    vscode.commands.registerCommand(
      'mergeForge.resolveThis',
      (arg?: vscode.Uri | { resourceUri?: vscode.Uri }) =>
        open(arg instanceof vscode.Uri ? arg : arg?.resourceUri),
    ),
    vscode.commands.registerCommand('mergeForge.abortMerge', async () => {
      const repoRoot = knownRepoRoot ?? (await activeRepoRoot());
      const operation = repoRoot ? await detectOperation(repoRoot) : undefined;
      if (!repoRoot || !operation || operation.kind === 'unknown') {
        void vscode.window.showInformationMessage(
          'Merge Forge: no merge, rebase, or cherry-pick is in progress.',
        );
        return;
      }
      if (await confirmAndAbort(repoRoot, operation)) {
        await contextKeys.refresh();
      }
    }),
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
    vscode.commands.registerCommand('mergeForge.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Anthropic API Key',
        prompt:
          'Stored securely in VS Code SecretStorage; used only by "Explain conflicts with AI".',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-ant-…',
      });
      if (key) {
        await context.secrets.store(API_KEY_SECRET, key.trim());
        void vscode.window.showInformationMessage('Merge Forge: Anthropic API key saved.');
      }
    }),
    vscode.commands.registerCommand('mergeForge.clearApiKey', async () => {
      await context.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage('Merge Forge: Anthropic API key removed.');
    }),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      // Opening a conflicted file can jump straight into the merge editor, for people
      // who would rather never see the markers.
      if (editor && readAutoOpen() && conflictedPaths.has(editor.document.uri.fsPath)) {
        await MergePanel.createOrShow(context, editor.document.uri);
      }
    }),
  );
}

function readAutoOpen(): boolean {
  return vscode.workspace.getConfiguration('mergeForge').get<boolean>('autoOpenOnConflict', false);
}

function readAutoShow(): boolean {
  return vscode.workspace.getConfiguration('mergeForge').get<boolean>('autoShowConflicts', true);
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
