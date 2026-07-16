import type { Chunk, ChunkState, ChunkSubtype } from '../src/merge/chunk';
import type { CenterRange } from './alignment';
import type { monaco } from './monaco';
import type { PaneName } from './panes';

/** JetBrains colour scheme: blue modified, green added, gray deleted, red conflict. */
function classesFor(kind: 'mod' | 'add' | 'del' | 'conf', state: ChunkState): string[] {
  const classes = [`mf-${kind}`];
  if (state === 'ignored') {
    classes.push('mf-ignored');
  } else if (state !== 'initial') {
    classes.push('mf-resolved');
  }
  return classes;
}

function kindForSide(chunk: Chunk, subtype: ChunkSubtype): 'mod' | 'add' | 'del' | 'conf' | null {
  if (subtype === 'none') {
    return null;
  }
  if (chunk.kind === 'conflict') {
    return 'conf';
  }
  switch (subtype) {
    case 'added':
      return 'add';
    case 'deleted':
      return 'del';
    case 'modified':
      return 'mod';
  }
}

/**
 * Converts a 0-based half-open line range into a Monaco whole-line range.
 * An empty range (a pure insertion point) has nothing to paint.
 */
function toMonacoRange(range: { start: number; end: number }): monaco.IRange | null {
  if (range.end <= range.start) {
    return null;
  }
  return {
    startLineNumber: range.start + 1,
    startColumn: 1,
    endLineNumber: range.end,
    endColumn: Number.MAX_SAFE_INTEGER,
  };
}

function decorationFor(
  range: { start: number; end: number },
  kind: 'mod' | 'add' | 'del' | 'conf',
  state: ChunkState,
): monaco.editor.IModelDeltaDecoration | null {
  const monacoRange = toMonacoRange(range);
  if (!monacoRange) {
    return null;
  }
  return {
    range: monacoRange,
    options: {
      isWholeLine: true,
      className: classesFor(kind, state).join(' '),
      linesDecorationsClassName: `mf-stripe mf-stripe-${kind}`,
    },
  };
}

/**
 * Repaints every chunk highlight from current state.
 *
 * The center pane is painted from live tracked ranges, not `chunk.base`, so highlights
 * follow the text after an accept or a manual edit.
 */
export function renderDecorations(
  chunks: readonly Chunk[],
  centerRanges: ReadonlyMap<number, CenterRange>,
  collections: Record<PaneName, monaco.editor.IEditorDecorationsCollection>,
): void {
  const byPane: Record<PaneName, monaco.editor.IModelDeltaDecoration[]> = {
    left: [],
    center: [],
    right: [],
  };

  for (const chunk of chunks) {
    const leftKind = kindForSide(chunk, chunk.leftSubtype);
    if (leftKind) {
      const decoration = decorationFor(chunk.left, leftKind, chunk.state);
      if (decoration) {
        byPane.left.push(decoration);
      }
    }
    const rightKind = kindForSide(chunk, chunk.rightSubtype);
    if (rightKind) {
      const decoration = decorationFor(chunk.right, rightKind, chunk.state);
      if (decoration) {
        byPane.right.push(decoration);
      }
    }
    // The center shows the chunk's overall kind, since it holds the merged result.
    const centerKind = chunk.kind === 'conflict' ? 'conf' : 'mod';
    const centerRange = centerRanges.get(chunk.id);
    if (centerRange) {
      const decoration = decorationFor(centerRange, centerKind, chunk.state);
      if (decoration) {
        byPane.center.push(decoration);
      }
    }
  }

  for (const name of ['left', 'center', 'right'] as const) {
    collections[name].set(byPane[name]);
  }
}
