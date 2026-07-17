import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import type { ExplainRequest } from '../protocol';
import { buildExplainPrompt } from './prompt';

export const API_KEY_SECRET = 'mergeForge.anthropicKey';

export interface ExplainCallbacks {
  onDelta(text: string): void;
  onDone(): void;
  onError(message: string): void;
}

export type ExplainProvider =
  | {
      kind: 'vscode-lm' | 'anthropic';
      explain(
        request: ExplainRequest,
        callbacks: ExplainCallbacks,
        token: vscode.CancellationToken,
      ): Promise<void>;
    }
  | { kind: 'unconfigured' };

/**
 * Picks the AI backend: the editor's own Language Model API when it offers models
 * (VS Code with Copilot; Cursor currently exposes none), else a direct Anthropic
 * call with the key from SecretStorage, else "unconfigured" so the UI can guide setup.
 */
export async function getExplainProvider(
  context: vscode.ExtensionContext,
): Promise<ExplainProvider> {
  const model = await findLanguageModel();
  if (model) {
    return { kind: 'vscode-lm', explain: (req, cb, token) => explainViaLm(model, req, cb, token) };
  }
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  if (apiKey) {
    return {
      kind: 'anthropic',
      explain: (req, cb, token) => explainViaAnthropic(apiKey, req, cb, token),
    };
  }
  return { kind: 'unconfigured' };
}

async function findLanguageModel(): Promise<vscode.LanguageModelChat | undefined> {
  // Guarded feature-detect: Cursor and older hosts either lack `lm` or return no models.
  if (!('lm' in vscode) || typeof vscode.lm.selectChatModels !== 'function') {
    return undefined;
  }
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models[0];
  } catch {
    return undefined;
  }
}

async function explainViaLm(
  model: vscode.LanguageModelChat,
  request: ExplainRequest,
  callbacks: ExplainCallbacks,
  token: vscode.CancellationToken,
): Promise<void> {
  const { system, user } = buildExplainPrompt(request);
  try {
    // The LM API has no system role at our floor version; prepend it to the user turn.
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(`${system}\n\n---\n\n${user}`)],
      {},
      token,
    );
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) {
        return;
      }
      callbacks.onDelta(fragment);
    }
    callbacks.onDone();
  } catch (error) {
    if (token.isCancellationRequested) {
      return;
    }
    if (error instanceof vscode.LanguageModelError) {
      callbacks.onError(`Language model unavailable: ${error.message}`);
      return;
    }
    callbacks.onError(error instanceof Error ? error.message : String(error));
  }
}

async function explainViaAnthropic(
  apiKey: string,
  request: ExplainRequest,
  callbacks: ExplainCallbacks,
  token: vscode.CancellationToken,
): Promise<void> {
  const model = vscode.workspace
    .getConfiguration('mergeForge')
    .get<string>('ai.model', 'claude-opus-4-8');
  const { system, user } = buildExplainPrompt(request);
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  const cancellation = token.onCancellationRequested(() => stream.abort());
  stream.on('text', (delta) => callbacks.onDelta(delta));
  try {
    await stream.finalMessage();
    callbacks.onDone();
  } catch (error) {
    if (token.isCancellationRequested || error instanceof Anthropic.APIUserAbortError) {
      return;
    }
    if (error instanceof Anthropic.AuthenticationError) {
      callbacks.onError(
        'Invalid Anthropic API key — run "Merge Forge: Set Anthropic API Key" to update it.',
      );
    } else if (error instanceof Anthropic.RateLimitError) {
      callbacks.onError('Anthropic API rate limit hit — wait a moment and try again.');
    } else if (error instanceof Anthropic.APIError) {
      callbacks.onError(`Anthropic API error (${String(error.status ?? '?')}): ${error.message}`);
    } else {
      callbacks.onError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    cancellation.dispose();
  }
}
