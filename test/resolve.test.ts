import { describe, expect, test } from 'vitest';
import type { Chunk } from '../src/merge/chunk';
import { computeChunks, joinLines } from '../src/merge/engine';
import {
  canAccept,
  canIgnore,
  canMagicResolve,
  chunkTexts,
  nonConflictingAction,
  resolveAction,
  textForState,
} from '../src/merge/resolve';

const lines = (...ls: string[]) => `${ls.join('\n')}\n`;

/** Applies every chunk's resolved text back into a full document, as the center pane would. */
function applyAll(
  base: string,
  left: string,
  right: string,
  chunks: Chunk[],
  pick: (chunk: Chunk) => Chunk['state'],
): string {
  const baseLines = base === '' ? [] : (base.match(/[^\n]*\n|[^\n]+/g) ?? []);
  const out: string[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    out.push(...baseLines.slice(cursor, chunk.base.start));
    out.push(...textForState(chunkTexts(chunk, base, left, right), pick(chunk)));
    cursor = chunk.base.end;
  }
  out.push(...baseLines.slice(cursor));
  return joinLines(out);
}

describe('textForState', () => {
  const base = lines('a', 'b', 'z');
  const left = lines('a', 'L', 'z');
  const right = lines('a', 'R', 'z');
  const chunk = computeChunks(base, left, right)[0]!;
  const texts = chunkTexts(chunk, base, left, right);

  test('an unresolved chunk keeps the base text', () => {
    expect(textForState(texts, 'initial')).toEqual(['b\n']);
  });

  test('accepting a side yields that side text', () => {
    expect(textForState(texts, 'appliedLeft')).toEqual(['L\n']);
    expect(textForState(texts, 'appliedRight')).toEqual(['R\n']);
  });

  test('accepting both stacks left then right', () => {
    expect(textForState(texts, 'appliedBoth')).toEqual(['L\n', 'R\n']);
  });

  test('an ignored chunk deliberately keeps base, taking neither side', () => {
    expect(textForState(texts, 'ignored')).toEqual(['b\n']);
  });
});

describe('resolveAction', () => {
  const base = lines('a', 'b', 'z');
  const left = lines('a', 'L', 'z');
  const right = lines('a', 'R', 'z');

  test('accepting left on a conflict gives the left text and state', () => {
    const chunk = computeChunks(base, left, right)[0]!;
    const result = resolveAction(chunk, chunkTexts(chunk, base, left, right), 'acceptLeft');
    expect(result).toEqual({ state: 'appliedLeft', lines: ['L\n'] });
  });

  test('accepting the second side of a conflict produces both texts', () => {
    const chunk = { ...computeChunks(base, left, right)[0]!, state: 'appliedLeft' as const };
    const result = resolveAction(chunk, chunkTexts(chunk, base, left, right), 'acceptRight');
    expect(result).toEqual({ state: 'appliedBoth', lines: ['L\n', 'R\n'] });
  });

  test('an action that is not offered resolves to null', () => {
    const chunk = { ...computeChunks(base, left, right)[0]!, state: 'ignored' as const };
    expect(resolveAction(chunk, chunkTexts(chunk, base, left, right), 'acceptLeft')).toBeNull();
  });

  test('reverting restores the base text', () => {
    const chunk = { ...computeChunks(base, left, right)[0]!, state: 'appliedBoth' as const };
    const result = resolveAction(chunk, chunkTexts(chunk, base, left, right), 'revert');
    expect(result).toEqual({ state: 'initial', lines: ['b\n'] });
  });
});

describe('button availability', () => {
  const base = lines('a', 'b', 'z');

  test('a left-only change offers only the left accept', () => {
    const chunk = computeChunks(base, lines('a', 'L', 'z'), base)[0]!;
    expect(canAccept(chunk, 'left')).toBe(true);
    expect(canAccept(chunk, 'right')).toBe(false);
    expect(canIgnore(chunk)).toBe(true);
  });

  test('a conflict offers both accepts', () => {
    const chunk = computeChunks(base, lines('a', 'L', 'z'), lines('a', 'R', 'z'))[0]!;
    expect(canAccept(chunk, 'left')).toBe(true);
    expect(canAccept(chunk, 'right')).toBe(true);
  });

  test('an applied chunk stops offering the side it already took', () => {
    const chunk = {
      ...computeChunks(base, lines('a', 'L', 'z'), lines('a', 'R', 'z'))[0]!,
      state: 'appliedLeft' as const,
    };
    expect(canAccept(chunk, 'left')).toBe(false);
    expect(canAccept(chunk, 'right')).toBe(true);
    // Ignoring is a decision about an untouched chunk, so it is gone once applied.
    expect(canIgnore(chunk)).toBe(false);
  });
});

describe('nonConflictingAction', () => {
  // The stable "c" between the two edits matters: edits touching at a base boundary
  // cluster into a single conflict (git agrees), so a gap is what makes these separate,
  // independently-appliable chunks.
  const base = lines('a', 'b', 'c', 'd', 'z');
  const left = lines('a', 'L', 'c', 'd', 'z');
  const right = lines('a', 'b', 'c', 'R', 'z');

  test('takes each side changed, and never touches a conflict', () => {
    const conflict = computeChunks(base, lines('a', 'L', 'z'), lines('a', 'R', 'z'))[0]!;
    expect(nonConflictingAction(conflict)).toBeNull();

    const [leftChunk, rightChunk] = computeChunks(base, left, right);
    expect(nonConflictingAction(leftChunk!)).toBe('acceptLeft');
    expect(nonConflictingAction(rightChunk!)).toBe('acceptRight');
  });

  test('restricting to one side skips the other side changes', () => {
    const [leftChunk, rightChunk] = computeChunks(base, left, right);
    expect(nonConflictingAction(leftChunk!, 'left')).toBe('acceptLeft');
    expect(nonConflictingAction(rightChunk!, 'left')).toBeNull();
    expect(nonConflictingAction(leftChunk!, 'right')).toBeNull();
    expect(nonConflictingAction(rightChunk!, 'right')).toBe('acceptRight');
  });

  test('skips chunks the user already decided', () => {
    const chunk = { ...computeChunks(base, left, right)[0]!, state: 'ignored' as const };
    expect(nonConflictingAction(chunk)).toBeNull();
  });

  // Verified against `git merge-file`, which merges this triple cleanly to the same text.
  test('applying every non-conflicting change reproduces a clean git merge', () => {
    const chunks = computeChunks(base, left, right);
    const merged = applyAll(base, left, right, chunks, (chunk) => {
      const action = nonConflictingAction(chunk);
      if (action === 'acceptLeft') {
        return 'appliedLeft';
      }
      return action === 'acceptRight' ? 'appliedRight' : 'initial';
    });
    expect(merged).toBe(lines('a', 'L', 'c', 'R', 'z'));
  });
});

describe('canMagicResolve', () => {
  test('offers itself when both sides inserted at the same point', () => {
    const chunk = computeChunks(lines('a', 'z'), lines('a', 'L', 'z'), lines('a', 'R', 'z'))[0]!;
    expect(chunk.bothInserted).toBe(true);
    expect(canMagicResolve(chunk)).toBe(true);
  });

  test('refuses a genuine rewrite of the same lines, where keeping both would be wrong', () => {
    const chunk = computeChunks(
      lines('a', 'b', 'z'),
      lines('a', 'L', 'z'),
      lines('a', 'R', 'z'),
    )[0]!;
    expect(canMagicResolve(chunk)).toBe(false);
  });

  test('refuses a chunk that is already decided', () => {
    const chunk = {
      ...computeChunks(lines('a', 'z'), lines('a', 'L', 'z'), lines('a', 'R', 'z'))[0]!,
      state: 'appliedLeft' as const,
    };
    expect(canMagicResolve(chunk)).toBe(false);
  });

  test('magic resolving keeps both insertions', () => {
    const base = lines('a', 'z');
    const left = lines('a', 'L', 'z');
    const right = lines('a', 'R', 'z');
    const chunk = computeChunks(base, left, right)[0]!;
    const texts = chunkTexts(chunk, base, left, right);
    expect(textForState(texts, 'appliedBoth')).toEqual(['L\n', 'R\n']);
  });
});
