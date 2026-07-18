import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import { buildExplainPrompt, buildResolvePrompt } from '../ai/prompt';
import { getExplainProvider, type ExplainProvider } from '../ai/provider';
import { parseResolutions } from '../ai/resolveParser';
import { applyResolved } from '../git/applyResult';
import { listConflicted } from '../git/conflicts';
import { loadMergeInputs, type UnsupportedReason } from '../git/loadMerge';
import { findRepoRoot } from '../git/repoContext';
import type { EolSetting } from '../merge/lineEndings';
import type {
  Eol,
  ExplainRequest,
  HostToWebviewMessage,
  InitPayload,
  MergeAction,
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
  /** Cancels the in-flight AI explanation; recreated per request. */
  private explainCancellation: vscode.CancellationTokenSource | undefined;

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

    // Tab-title progress: "(2/5)" — position in the conflicted list at open time.
    const conflicted = await listConflicted(repoRoot).catch(() => [] as string[]);
    const position = conflicted.indexOf(relativePath) + 1;
    const progress =
      position > 0 && conflicted.length > 1 ? ` (${position}/${conflicted.length})` : '';
    const panel = vscode.window.createWebviewPanel(
      'mergeForge.mergeEditor',
      `Merge: ${relativePath}${progress}`,
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
    MergePanel.panels.set(
      key,
      new MergePanel(panel, context, key, uri, payload, repoRoot, relativePath, inputs.hadBom),
    );
  }

  /** Forwards a command to the focused merge panel, if there is one. */
  static runOnActive(action: MergeAction): void {
    for (const panel of MergePanel.panels.values()) {
      if (panel.panel.active) {
        panel.post({ type: 'runAction', action });
        return;
      }
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly key: string,
    readonly uri: vscode.Uri,
    private readonly payload: InitPayload,
    private readonly repoRoot: string,
    private readonly relativePath: string,
    private readonly hadBom: boolean,
  ) {
    this.panel.webview.html = getWebviewHtml(this.panel.webview, context.extensionUri);
    this.panel.onDidDispose(() => {
      MergePanel.panels.delete(this.key);
      this.cancelExplain();
      void vscode.commands.executeCommand('setContext', 'mergeForge.panelFocused', false);
    });
    this.panel.onDidChangeViewState(() => {
      void vscode.commands.executeCommand(
        'setContext',
        'mergeForge.panelFocused',
        this.panel.active,
      );
    });
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
        void this.abort();
        break;
      case 'log':
        console[message.level === 'error' ? 'error' : 'warn'](`[merge-forge] ${message.message}`);
        break;
      case 'apply':
        void this.apply(message.payload.content, message.payload.eol);
        break;
      case 'explain':
        void this.explain(message.payload);
        break;
      case 'aiResolve':
        void this.aiResolve(message.payload.request, message.payload.explanation);
        break;
      case 'explainCancel':
        this.cancelExplain();
        break;
      case 'openAiSetup':
        void vscode.commands.executeCommand('mergeForge.setApiKey');
        break;
    }
  }

  /** Streams an AI explanation of the file's conflicts back into the webview drawer. */
  private async explain(request: ExplainRequest): Promise<void> {
    const started = await this.startAiRequest();
    if (!started) {
      return;
    }
    await started.provider.stream(
      buildExplainPrompt(request),
      {
        onDelta: (text) => this.post({ type: 'explainDelta', text }),
        onDone: (truncated) =>
          this.post({ type: 'explainDone', ...(truncated ? { truncated: true } : {}) }),
        onError: (message) => this.post({ type: 'explainError', message }),
      },
      started.token,
    );
  }

  /**
   * "Resolve with AI": one request returns machine-parsed merged blocks; only what
   * parses is sent back — a skipped or garbled block just leaves that conflict open.
   */
  private async aiResolve(request: ExplainRequest, explanation?: string): Promise<void> {
    const started = await this.startAiRequest();
    if (!started) {
      return;
    }
    let accumulated = '';
    await started.provider.stream(
      buildResolvePrompt(request, explanation),
      {
        onDelta: (text) => {
          accumulated += text;
        },
        onDone: () => {
          const byIndex = parseResolutions(
            accumulated,
            request.conflicts.map((c) => c.index),
          );
          const resolutions = request.conflicts
            .filter((c) => byIndex.has(c.index))
            .map((c) => ({ chunkId: c.chunkId, text: byIndex.get(c.index)! }));
          this.post({
            type: 'aiResolutions',
            resolutions,
            missing: request.conflicts.length - resolutions.length,
          });
        },
        onError: (message) => this.post({ type: 'explainError', message }),
      },
      started.token,
    );
  }

  /** Shared preamble: cancel any in-flight request, resolve the backend, or report setup. */
  private async startAiRequest(): Promise<
    | {
        provider: Exclude<ExplainProvider, { kind: 'unconfigured' }>;
        token: vscode.CancellationToken;
      }
    | undefined
  > {
    this.cancelExplain();
    const cancellation = new vscode.CancellationTokenSource();
    this.explainCancellation = cancellation;
    const provider = await getExplainProvider(this.context);
    if (provider.kind === 'unconfigured') {
      this.post({
        type: 'explainError',
        message: 'No AI backend is configured.',
        unconfigured: true,
      });
      return undefined;
    }
    if (cancellation.token.isCancellationRequested) {
      return undefined;
    }
    return { provider, token: cancellation.token };
  }

  private cancelExplain(): void {
    this.explainCancellation?.cancel();
    this.explainCancellation?.dispose();
    this.explainCancellation = undefined;
  }

  /**
   * Writes the result and marks the file resolved.
   *
   * Applying with conflicts still untouched would stage a file containing the base text
   * where a decision belonged — quietly discarding both sides' work — so that needs an
   * explicit confirmation rather than a silent success.
   */
  private async apply(content: string, eol: Eol): Promise<void> {
    const unresolved = this.latestState?.unresolvedConflicts ?? 0;
    if (unresolved > 0) {
      const proceed = await vscode.window.showWarningMessage(
        `${unresolved} conflict${unresolved === 1 ? '' : 's'} in "${this.relativePath}" ${
          unresolved === 1 ? 'is' : 'are'
        } still unresolved. Applying now keeps the original version for ${
          unresolved === 1 ? 'it' : 'them'
        }.`,
        { modal: true },
        'Apply Anyway',
      );
      if (proceed !== 'Apply Anyway') {
        this.post({ type: 'applyResult', ok: false, error: 'cancelled' });
        return;
      }
    }

    try {
      await applyResolved(this.repoRoot, this.relativePath, content, eol, this.hadBom);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.post({ type: 'applyResult', ok: false, error: detail });
      void vscode.window.showErrorMessage(`Merge Forge: could not apply — ${detail}`);
      return;
    }

    this.panel.dispose();
    await this.reportProgress();
  }

  /** Tells the user where the merge stands, and keeps the loop going to the next file. */
  private async reportProgress(): Promise<void> {
    const remaining = await listConflicted(this.repoRoot).catch(() => undefined);
    if (remaining === undefined) {
      return;
    }
    if (remaining.length === 0) {
      void vscode.window.showInformationMessage(
        `Resolved "${this.relativePath}" — all conflicts resolved, ready to commit.`,
      );
      return;
    }
    const next = vscode.Uri.file(join(this.repoRoot, remaining[0]!));
    if (readAutoAdvance()) {
      // Keyboard-driven loop: straight into the next conflicted file, no stop.
      await vscode.commands.executeCommand('mergeForge.resolveThis', next);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Resolved "${this.relativePath}" — ${remaining.length} conflicted file${
        remaining.length === 1 ? '' : 's'
      } left.`,
      'Next Conflict',
    );
    if (choice === 'Next Conflict') {
      await vscode.commands.executeCommand('mergeForge.resolveThis', next);
    }
  }

  /** Closes without touching the conflicted file, so the merge can be restarted. */
  private async abort(): Promise<void> {
    if (this.latestState?.dirty) {
      const discard = await vscode.window.showWarningMessage(
        `Discard your work on "${this.relativePath}"? The file keeps its conflict markers.`,
        { modal: true },
        'Discard',
      );
      if (discard !== 'Discard') {
        return;
      }
    }
    this.panel.dispose();
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

function readAutoAdvance(): boolean {
  return vscode.workspace.getConfiguration('mergeForge').get<boolean>('autoAdvance', false);
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
