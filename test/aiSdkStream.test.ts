import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// provider.ts imports 'vscode' at module scope; explainViaAiSdk itself never calls it,
// so a bare stub is enough to load the module outside an extension host.
vi.mock('vscode', () => ({}));

import { explainViaAiSdk, type ExplainCallbacks } from '../src/ai/provider';
import type { ExplainRequest } from '../src/protocol';

/**
 * Drives the real AI SDK streaming path against a local OpenAI-compatible SSE stub —
 * the same protocol DeepSeek, Kimi, OpenAI, and Custom endpoints speak — so request
 * shape, delta forwarding, completion, and error mapping are verified without any key.
 */

const SSE_CHUNKS = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];

let server: Server;
let baseUrl = '';
/** Behavior switch per request, keyed by the model id the client asks for. */
let lastRequestBody = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      lastRequestBody = body;
      const wantsError = body.includes('"model":"error-model"');
      if (wantsError) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const common = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'stub',
      };
      for (const chunk of SSE_CHUNKS) {
        res.write(`data: ${JSON.stringify({ ...common, ...chunk })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
});

const request: ExplainRequest = {
  filePath: 'src/a.ts',
  languageId: 'typescript',
  labels: { left: 'feature', right: 'main' },
  conflicts: [{ index: 1, baseText: 'a\n', leftText: 'b\n', rightText: 'c\n' }],
};

function token(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as never;
}

function collect() {
  const deltas: string[] = [];
  const events: string[] = [];
  const callbacks: ExplainCallbacks = {
    onDelta: (text) => deltas.push(text),
    onDone: () => events.push('done'),
    onError: (message) => events.push(`error:${message}`),
  };
  return { deltas, events, callbacks };
}

function model(modelId: string) {
  return createOpenAICompatible({ name: 'stub', baseURL: baseUrl, apiKey: 'test' })(modelId);
}

describe('explainViaAiSdk against a local OpenAI-compatible stub', () => {
  test('forwards streamed deltas and finishes with onDone', async () => {
    const { deltas, events, callbacks } = collect();
    await explainViaAiSdk(model('ok-model'), 'Stub', request, callbacks, token());
    expect(deltas.join('')).toBe('Hello world');
    expect(events).toEqual(['done']);
    // The request carried our prompt: system + the conflict texts.
    expect(lastRequestBody).toContain('three-way');
    expect(lastRequestBody).toContain('feature');
  });

  test('maps a 401 to the invalid-key message, no onDone', async () => {
    const { events, callbacks } = collect();
    await explainViaAiSdk(model('error-model'), 'Stub', request, callbacks, token());
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('Invalid Stub API key');
    expect(events[0]).toContain('Set AI Provider & API Key');
  });
});
