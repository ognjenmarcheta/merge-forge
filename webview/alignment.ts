import type { Chunk } from '../src/merge/chunk';
import type { PaneName } from './panes';

/**
 * Pure layout math for the three panes. Deliberately free of Monaco imports: this is the
 * logic most likely to drift under editing, so it has to be testable without a browser.
 */

/** The colour family a chunk paints with — drives gap tints as well as line fills. */
export type ChunkVisual = 'mod' | 'add' | 'del' | 'conf';

/** Reduces a chunk to its one visual family, for surfaces that show a single colour. */
export function visualOf(chunk: Chunk): ChunkVisual {
  if (chunk.kind === 'conflict') {
    return 'conf';
  }
  if (chunk.leftSubtype === 'added' || chunk.rightSubtype === 'added') {
    return 'add';
  }
  if (chunk.leftSubtype === 'deleted' || chunk.rightSubtype === 'deleted') {
    return 'del';
  }
  return 'mod';
}

/** One aligned row: the same logical region, measured in each pane's own lines. */
export interface Segment {
  left: number;
  center: number;
  right: number;
  /** 0-based line each pane's region starts at, used to anchor the spacer. */
  startLeft: number;
  startCenter: number;
  startRight: number;
  /** Set on chunk segments: what colour any padding for this row should carry. */
  visual?: ChunkVisual;
}

/** Where a chunk currently sits in the center document. */
export interface CenterRange {
  start: number;
  end: number;
}

export interface LineTotals {
  left: number;
  center: number;
  right: number;
}

/**
 * Splits the documents into aligned rows: stable text, chunk, stable text, and so on.
 *
 * Center positions come from live tracked ranges rather than `chunk.base`, because
 * editing the center pane moves everything below the edit.
 */
export function computeSegments(
  chunks: readonly Chunk[],
  centerRanges: ReadonlyMap<number, CenterRange>,
  totals: LineTotals,
): Segment[] {
  const segments: Segment[] = [];
  let leftCursor = 0;
  let centerCursor = 0;
  let rightCursor = 0;

  for (const chunk of chunks) {
    const center = centerRanges.get(chunk.id) ?? { start: chunk.base.start, end: chunk.base.end };
    // Text between chunks is identical in all three documents, so it has equal height.
    const stable = chunk.left.start - leftCursor;
    if (stable > 0) {
      segments.push({
        left: stable,
        center: Math.max(0, center.start - centerCursor),
        right: stable,
        startLeft: leftCursor,
        startCenter: centerCursor,
        startRight: rightCursor,
      });
      leftCursor += stable;
      centerCursor = center.start;
      rightCursor += stable;
    }
    segments.push({
      left: chunk.left.end - chunk.left.start,
      center: center.end - center.start,
      right: chunk.right.end - chunk.right.start,
      startLeft: chunk.left.start,
      startCenter: center.start,
      startRight: chunk.right.start,
      visual: visualOf(chunk),
    });
    leftCursor = chunk.left.end;
    centerCursor = center.end;
    rightCursor = chunk.right.end;
  }

  if (leftCursor < totals.left || centerCursor < totals.center || rightCursor < totals.right) {
    segments.push({
      left: totals.left - leftCursor,
      center: totals.center - centerCursor,
      right: totals.right - rightCursor,
      startLeft: leftCursor,
      startCenter: centerCursor,
      startRight: rightCursor,
    });
  }
  return segments;
}

/** Padding to insert after a line so a pane matches the tallest pane for that row. */
export interface Spacer {
  /** 0-based line to insert after; Monaco reads this as its 1-based `afterLineNumber`. */
  afterLine: number;
  heightInLines: number;
  /** Colour family of the chunk this padding stands in for; stable gaps carry none. */
  visual?: ChunkVisual;
}

/**
 * Works out the padding each pane needs so every segment occupies the same number of
 * lines in all three panes. Equal heights are what let scroll sync be a plain 1:1 mirror
 * instead of an interpolation.
 */
export function computeSpacers(segments: readonly Segment[]): Record<PaneName, Spacer[]> {
  const spacers: Record<PaneName, Spacer[]> = { left: [], center: [], right: [] };
  for (const segment of segments) {
    const tallest = Math.max(segment.left, segment.center, segment.right);
    const rows: Array<[PaneName, number, number]> = [
      ['left', segment.left, segment.startLeft],
      ['center', segment.center, segment.startCenter],
      ['right', segment.right, segment.startRight],
    ];
    for (const [pane, own, start] of rows) {
      const missing = tallest - own;
      if (missing > 0) {
        const spacer: Spacer = { afterLine: start + own, heightInLines: missing };
        if (segment.visual) {
          spacer.visual = segment.visual;
        }
        spacers[pane].push(spacer);
      }
    }
  }
  return spacers;
}
