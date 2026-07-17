import { describe, expect, test } from 'vitest';
import { buildExplainPrompt, SIDE_TEXT_CAP } from '../src/ai/prompt';
import type { ExplainRequest } from '../src/protocol';

function request(overrides: Partial<ExplainRequest> = {}): ExplainRequest {
  return {
    filePath: 'src/components/CreateMetricModal.vue',
    languageId: 'vue',
    labels: { left: 'feature/metrics', right: 'main' },
    conflicts: [
      {
        index: 1,
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
          { index: 1, baseText: 'one\n', leftText: 'uno\n', rightText: 'eins\n' },
          { index: 2, baseText: 'two\n', leftText: 'dos\n', rightText: 'zwei\n' },
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
          { index: 1, baseText: 'one\n', leftText: 'uno\n', rightText: 'eins\n' },
          { index: 2, baseText: 'two\n', leftText: 'dos\n', rightText: 'zwei\n' },
          { index: 3, baseText: 'three\n', leftText: 'tres\n', rightText: 'drei\n' },
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
      request({ conflicts: [{ index: 1, baseText: '', leftText: long, rightText: 'ok\n' }] }),
    );
    expect(user).toContain('…truncated…');
    expect(user).not.toContain('x'.repeat(SIDE_TEXT_CAP + 1));
  });

  test('an empty side is rendered as deleted, not as an empty block', () => {
    const { user } = buildExplainPrompt(
      request({ conflicts: [{ index: 1, baseText: 'gone\n', leftText: '', rightText: 'kept\n' }] }),
    );
    expect(user).toContain('(no lines — deleted)');
  });
});
