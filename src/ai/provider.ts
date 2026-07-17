import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, streamText, type LanguageModel } from 'ai';
import * as vscode from 'vscode';
import type { ExplainRequest } from '../protocol';
import { buildExplainPrompt } from './prompt';
import { providerById, resolveModel, type ProviderSpec } from './providers';

/** Legacy secret name from the Anthropic-only release; still read as a fallback. */
export const API_KEY_SECRET = 'mergeForge.anthropicKey';

/** Per-provider secret name in SecretStorage. */
export function secretKeyFor(providerId: string): string {
  return `mergeForge.aiKey.${providerId}`;
}

export interface ExplainCallbacks {
  onDelta(text: string): void;
  /** `truncated` is set when the model hit the output-token cap mid-answer. */
  onDone(truncated?: boolean): void;
  onError(message: string): void;
}

export type ExplainProvider =
  | {
      kind: 'vscode-lm' | 'api';
      explain(
        request: ExplainRequest,
        callbacks: ExplainCallbacks,
        token: vscode.CancellationToken,
      ): Promise<void>;
    }
  | { kind: 'unconfigured' };

/**
 * Picks the AI backend: the editor's own Language Model API when it offers models
 * (VS Code with Copilot; Cursor currently exposes none), else the provider the user
 * configured (`mergeForge.ai.provider`) with its key from SecretStorage, else
 * "unconfigured" so the UI can guide setup.
 */
export async function getExplainProvider(
  context: vscode.ExtensionContext,
): Promise<ExplainProvider> {
  const lmModel = await findLanguageModel();
  if (lmModel) {
    return {
      kind: 'vscode-lm',
      explain: (req, cb, token) => explainViaLm(lmModel, req, cb, token),
    };
  }
  const configured = await configureApiModel(context);
  if (!configured) {
    return { kind: 'unconfigured' };
  }
  return {
    kind: 'api',
    explain: (req, cb, token) =>
      explainViaAiSdk(configured.model, configured.label, req, cb, token),
  };
}

/**
 * Builds the AI SDK model instance for the configured provider, or undefined when
 * the setup is incomplete (no key for a hosted provider; no base URL for custom).
 */
async function configureApiModel(
  context: vscode.ExtensionContext,
): Promise<{ model: LanguageModel; label: string } | undefined> {
  const config = vscode.workspace.getConfiguration('mergeForge');
  const spec = providerById(config.get<string>('ai.provider', 'anthropic'));
  if (!spec) {
    return undefined;
  }
  const apiKey = await keyFor(context, spec);
  const modelId = resolveModel(
    config.get<string>('ai.model', 'auto'),
    spec,
    config.get<string>('ai.customModel', ''),
  );

  if (spec.id === 'anthropic') {
    if (!apiKey) {
      return undefined;
    }
    return { model: createAnthropic({ apiKey })(modelId), label: spec.label };
  }

  const baseUrl = spec.baseUrl ?? config.get<string>('ai.customBaseUrl', '').trim();
  if (!baseUrl || (!apiKey && !spec.keyOptional) || modelId === '') {
    return undefined;
  }
  const provider = createOpenAICompatible({
    name: spec.id,
    baseURL: baseUrl,
    // Local endpoints like Ollama ignore auth; the header just has to exist.
    apiKey: apiKey || 'not-needed',
  });
  return { model: provider(modelId), label: spec.label };
}

async function keyFor(
  context: vscode.ExtensionContext,
  spec: ProviderSpec,
): Promise<string | undefined> {
  const stored = await context.secrets.get(secretKeyFor(spec.id));
  if (stored) {
    return stored;
  }
  // Migration: the Anthropic-only release stored the key under a different name.
  return spec.id === 'anthropic' ? context.secrets.get(API_KEY_SECRET) : undefined;
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

/** One streaming path for every API-key provider, via the AI SDK. */
export async function explainViaAiSdk(
  model: LanguageModel,
  providerLabel: string,
  request: ExplainRequest,
  callbacks: ExplainCallbacks,
  token: vscode.CancellationToken,
): Promise<void> {
  const { system, user } = buildExplainPrompt(request);
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed || token.isCancellationRequested) {
      return;
    }
    failed = true;
    callbacks.onError(describeError(error, providerLabel));
  };
  try {
    const result = streamText({
      model,
      system,
      prompt: user,
      // Generous cap: enough for many conflicts, but explicit so a hit is detectable.
      maxOutputTokens: 16000,
      abortSignal: controller.signal,
      // The AI SDK reports stream errors here rather than throwing from textStream.
      onError: ({ error }) => fail(error),
    });
    for await (const delta of result.textStream) {
      if (token.isCancellationRequested) {
        return;
      }
      callbacks.onDelta(delta);
    }
    if (!failed && !token.isCancellationRequested) {
      const finishReason = await result.finishReason;
      callbacks.onDone(finishReason === 'length');
    }
  } catch (error) {
    fail(error);
  } finally {
    cancellation.dispose();
  }
}

function describeError(error: unknown, providerLabel: string): string {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403) {
      return `Invalid ${providerLabel} API key — run "Merge Forge: Set AI Provider & API Key" to update it.`;
    }
    if (status === 429) {
      return `${providerLabel} API rate limit hit — wait a moment and try again.`;
    }
    return `${providerLabel} API error (${String(status ?? '?')}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
