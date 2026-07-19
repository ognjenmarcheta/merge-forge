import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type Tool,
} from 'ai';
import * as vscode from 'vscode';
import { providerById, resolveModel, type ProviderSpec } from './providers';
import { describeToolCall, runTool, TOOL_SPECS, type ToolExecutors } from './tools';

/** A ready-to-send prompt; built by the callers (explain vs resolve) in prompt.ts. */
export interface PromptPair {
  system: string;
  user: string;
}

/** Tool-loop step budgets: how many rounds of tool calls before we force an answer. */
export const STEP_BUDGET_RESOLVE = 8;
export const STEP_BUDGET_EXPLAIN = 4;

/** Legacy secret name from the Anthropic-only release; still read as a fallback. */
export const API_KEY_SECRET = 'mergeForge.anthropicKey';

/** Per-provider secret name in SecretStorage. */
export function secretKeyFor(providerId: string): string {
  return `mergeForge.aiKey.${providerId}`;
}

export interface ExplainCallbacks {
  onDelta(text: string): void;
  /** A tool-use progress line for the drawer: "⚙ Read src/x.ts". */
  onActivity?(text: string): void;
  /** `truncated` is set when the model hit the output-token cap mid-answer. */
  onDone(truncated?: boolean): void;
  onError(message: string): void;
}

/** Enables the agentic tool loop for a request. */
export interface StreamToolOptions {
  executors: ToolExecutors;
  stepBudget: number;
}

export type ExplainProvider =
  | {
      kind: 'vscode-lm' | 'api';
      /** False when this backend cannot honor tool calls (older lm hosts). */
      supportsTools: boolean;
      stream(
        prompt: PromptPair,
        callbacks: ExplainCallbacks,
        token: vscode.CancellationToken,
        tools?: StreamToolOptions,
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
      supportsTools: lmSupportsTools(),
      stream: (prompt, cb, token, tools) => streamViaLm(lmModel, prompt, cb, token, tools),
    };
  }
  const configured = await configureApiModel(context);
  if (!configured) {
    return { kind: 'unconfigured' };
  }
  return {
    kind: 'api',
    supportsTools: true,
    stream: (prompt, cb, token, tools) =>
      streamViaAiSdk(configured.model, configured.label, prompt, cb, token, tools),
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

/**
 * Whether this host's Language Model API can round-trip tool calls. The classes
 * arrived after our engine floor, so probe the namespace instead of assuming.
 */
export function lmSupportsTools(): boolean {
  const ns = vscode as unknown as Record<string, unknown>;
  return (
    typeof ns['LanguageModelToolCallPart'] === 'function' &&
    typeof ns['LanguageModelToolResultPart'] === 'function' &&
    typeof ns['LanguageModelTextPart'] === 'function'
  );
}

async function streamViaLm(
  model: vscode.LanguageModelChat,
  { system, user }: PromptPair,
  callbacks: ExplainCallbacks,
  token: vscode.CancellationToken,
  tools?: StreamToolOptions,
): Promise<void> {
  const toolOptions = tools !== undefined && lmSupportsTools() ? tools : undefined;
  const lmTools: vscode.LanguageModelChatTool[] = TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }));
  try {
    // The LM API has no system role at our floor version; prepend it to the user turn.
    const messages = [vscode.LanguageModelChatMessage.User(`${system}\n\n---\n\n${user}`)];
    const budget = toolOptions ? toolOptions.stepBudget : 1;
    for (let step = 0; step < budget; step++) {
      // The last budgeted step withholds the tools so the model must answer.
      const offerTools = toolOptions !== undefined && step < budget - 1;
      const response = await model.sendRequest(
        messages,
        offerTools ? { tools: lmTools } : {},
        token,
      );
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      let text = '';
      for await (const part of response.stream) {
        if (token.isCancellationRequested) {
          return;
        }
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          callbacks.onDelta(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }
      if (toolCalls.length === 0 || toolOptions === undefined) {
        callbacks.onDone();
        return;
      }
      // Echo the assistant turn (its text + calls), then answer each call in a
      // User message — the shape the LM API prescribes for tool results.
      const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> =
        text === '' ? [...toolCalls] : [new vscode.LanguageModelTextPart(text), ...toolCalls];
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
      const results: vscode.LanguageModelToolResultPart[] = [];
      for (const call of toolCalls) {
        callbacks.onActivity?.(describeToolCall(call.name, call.input));
        const output = await runTool(toolOptions.executors, call.name, call.input);
        results.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(output),
          ]),
        );
      }
      messages.push(vscode.LanguageModelChatMessage.User(results));
    }
    // Every budgeted step ended in tool calls; the loop above never got an answer.
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

/** Builds the AI SDK tool set: shared specs, activity lines emitted at call time. */
function aiSdkTools(options: StreamToolOptions, callbacks: ExplainCallbacks): Record<string, Tool> {
  const entries = TOOL_SPECS.map((spec) => [
    spec.name,
    tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
      // runTool never throws — failures return as text the model can read.
      execute: (input: unknown) => {
        callbacks.onActivity?.(describeToolCall(spec.name, input));
        return runTool(options.executors, spec.name, input);
      },
    }),
  ]);
  return Object.fromEntries(entries) as Record<string, Tool>;
}

/** One streaming path for every API-key provider, via the AI SDK. */
export async function streamViaAiSdk(
  model: LanguageModel,
  providerLabel: string,
  { system, user }: PromptPair,
  callbacks: ExplainCallbacks,
  token: vscode.CancellationToken,
  toolOptions?: StreamToolOptions,
): Promise<void> {
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
      ...(toolOptions
        ? {
            tools: aiSdkTools(toolOptions, callbacks),
            // +1: the budget counts tool rounds; the final step is the answer.
            stopWhen: stepCountIs(toolOptions.stepBudget + 1),
          }
        : {}),
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
