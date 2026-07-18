import { describe, expect, test } from 'vitest';
import {
  buildChatPrompt,
  buildExplainPrompt,
  buildResolvePrompt,
  SIDE_TEXT_CAP,
} from '../src/ai/prompt';
import type { ExplainRequest } from '../src/protocol';

function request(overrides: Partial<ExplainRequest> = {}): ExplainRequest {
  return {
    filePath: 'src/components/CreateMetricModal.vue',
    languageId: 'vue',
    labels: { left: 'feature/metrics', right: 'main' },
    conflicts: [
      {
        index: 1,
        chunkId: 0,
        baseText: 'const a = 1;\n',
        leftText: 'const a = 2;\n',
        rightText: 'const a = 3;\n',
      },
    ],
    ...overrides,
  };
}

describe('buildExplainPrompt', () => {
  test('user prompt names the file, language, and both branches', () => {
    const { user } = buildExplainPrompt(request());
    expect(user).toContain('src/components/CreateMetricModal.vue');
    expect(user).toContain('vue');
    expect(user).toContain('feature/metrics');
    expect(user).toContain('main');
  });

  test('one section per conflict with base and both sides fenced', () => {
    const { user } = buildExplainPrompt(
      request({
        conflicts: [
          { index: 1, chunkId: 1, baseText: 'one\n', leftText: 'uno\n', rightText: 'eins\n' },
          { index: 2, chunkId: 2, baseText: 'two\n', leftText: 'dos\n', rightText: 'zwei\n' },
        ],
      }),
    );
    expect(user).toContain('## Conflict 1');
    expect(user).toContain('## Conflict 2');
    expect(user).toContain('uno');
    expect(user).toContain('eins');
    expect(user).toContain('two');
    // Every conflict carries three fenced blocks: base, yours, theirs.
    expect(user.match(/```/g)?.length).toBe(2 * 3 * 2);
  });

  test('system prompt asks for per-conflict explanation and a suggested resolution', () => {
    const { system } = buildExplainPrompt(request());
    expect(system.toLowerCase()).toContain('resolution');
    expect(system).toContain('### Conflict');
    // The every-conflict contract lives in the system prompt…
    expect(system).toContain('every conflict');
  });

  test('user prompt closes with the exact expected section count', () => {
    const { user } = buildExplainPrompt(
      request({
        conflicts: [
          { index: 1, chunkId: 1, baseText: 'one\n', leftText: 'uno\n', rightText: 'eins\n' },
          { index: 2, chunkId: 2, baseText: 'two\n', leftText: 'dos\n', rightText: 'zwei\n' },
          { index: 3, chunkId: 3, baseText: 'three\n', leftText: 'tres\n', rightText: 'drei\n' },
        ],
      }),
    );
    // …and the per-request count contract in the user prompt, so a model can't
    // quietly stop after the first section.
    expect(user).toContain('exactly 3 "### Conflict" sections');
  });

  test('long sides are truncated at the cap with a marker', () => {
    const long = 'x'.repeat(SIDE_TEXT_CAP + 500);
    const { user } = buildExplainPrompt(
      request({
        conflicts: [{ index: 1, chunkId: 1, baseText: '', leftText: long, rightText: 'ok\n' }],
      }),
    );
    expect(user).toContain('…truncated…');
    expect(user).not.toContain('x'.repeat(SIDE_TEXT_CAP + 1));
  });

  test('an empty side is rendered as deleted, not as an empty block', () => {
    const { user } = buildExplainPrompt(
      request({
        conflicts: [
          { index: 1, chunkId: 1, baseText: 'gone\n', leftText: '', rightText: 'kept\n' },
        ],
      }),
    );
    expect(user).toContain('(no lines — deleted)');
  });
});

describe('buildResolvePrompt', () => {
  test('system prompt demands the delimiter protocol and nothing else', () => {
    const { system } = buildResolvePrompt(request());
    expect(system).toContain('<<<RESOLVED');
    expect(system).toContain('<<<END');
    expect(system.toLowerCase()).toContain('only');
  });

  test('user prompt carries the conflicts and the expected block count', () => {
    const { user } = buildResolvePrompt(
      request({
        conflicts: [
          { index: 1, chunkId: 1, baseText: 'one\n', leftText: 'uno\n', rightText: 'eins\n' },
          { index: 2, chunkId: 2, baseText: 'two\n', leftText: 'dos\n', rightText: 'zwei\n' },
        ],
      }),
    );
    expect(user).toContain('## Conflict 1');
    expect(user).toContain('## Conflict 2');
    expect(user).toContain('exactly 2');
    expect(user).toContain('<<<RESOLVED 1>>>');
  });

  test('a prior explanation is included as context when provided', () => {
    const { user } = buildResolvePrompt(request(), '### Conflict 1\nTake theirs.');
    expect(user).toContain('Earlier analysis');
    expect(user).toContain('Take theirs.');
  });

  test('without an explanation there is no analysis section', () => {
    const { user } = buildResolvePrompt(request());
    expect(user).not.toContain('Earlier analysis');
  });
});

describe('buildChatPrompt', () => {
  test('carries the conflicts, prior turns in order, and the new question last', () => {
    const { user } = buildChatPrompt(
      request(),
      [
        { question: 'Why do these collide?', answer: 'Both edited the greeting.' },
        { question: 'Which side is newer?', answer: 'Theirs, by commit date.' },
      ],
      'So which should I take?',
    );
    expect(user).toContain('## Conflict 1');
    const q1 = user.indexOf('Why do these collide?');
    const a1 = user.indexOf('Both edited the greeting.');
    const q2 = user.indexOf('Which side is newer?');
    const final = user.indexOf('So which should I take?');
    expect(q1).toBeGreaterThan(-1);
    expect(a1).toBeGreaterThan(q1);
    expect(q2).toBeGreaterThan(a1);
    expect(final).toBeGreaterThan(q2);
  });

  test('works with no history', () => {
    const { user, system } = buildChatPrompt(request(), [], 'What changed here?');
    expect(user).toContain('What changed here?');
    expect(system.toLowerCase()).toContain('question');
  });
});
