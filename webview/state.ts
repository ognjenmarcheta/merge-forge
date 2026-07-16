import type { Chunk, ChunkAction, Side } from '../src/merge/chunk';
import { transition } from '../src/merge/chunk';
import { joinLines } from '../src/merge/engine';
import { chunkTexts, resolveAction, textForState, type ChunkTexts } from '../src/merge/resolve';
import type { CenterRange } from './alignment';
import type { monaco } from './monaco';

/** Edits tagged with this source are ours; anything else came from the user. */
const EDIT_SOURCE = 'mergeForge';

/**
 * Owns chunk state and where each chunk lives in the center document.
 *
 * Positions are tracked with Monaco decorations rather than arithmetic: the user can type
 * anywhere in the result, and decorations are the only thing that reliably survives that.
 * Our own edits re-pin their decoration afterwards instead of trusting stickiness, since
 * a replacement's end position depends on how the edit is applied.
 */
export class ChunkStore {
  private readonly texts = new Map<number, ChunkTexts>();
  private readonly trackers = new Map<number, string>();
  private applying = false;

  constructor(
    readonly chunks: Chunk[],
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    base: string,
    left: string,
    right: string,
    private readonly onChange: () => void,
  ) {
    for (const chunk of chunks) {
      this.texts.set(chunk.id, chunkTexts(chunk, base, left, right));
    }
    this.installTrackers();
    this.watchUserEdits();
  }

  private get model(): monaco.editor.ITextModel {
    const model = this.editor.getModel();
    if (!model) {
      throw new Error('center editor has no model');
    }
    return model;
  }

  /**
   * Places one tracking decoration per chunk. The result pane starts as the base text, so
   * a chunk's initial center range is exactly its base range.
   */
  private installTrackers(): void {
    const model = this.model;
    for (const chunk of this.chunks) {
      const id = model.deltaDecorations(
        [],
        [{ range: toMonacoRange(model, chunk.base), options: { stickiness: STICKINESS } }],
      )[0];
      if (id) {
        this.trackers.set(chunk.id, id);
      }
    }
  }

  /** The chunk's live range in the center document, read back from its decoration. */
  centerRange(chunkId: number): CenterRange {
    const id = this.trackers.get(chunkId);
    const range = id ? this.model.getDecorationRange(id) : null;
    if (!range) {
      const chunk = this.chunks.find((c) => c.id === chunkId);
      return { start: chunk?.base.start ?? 0, end: chunk?.base.end ?? 0 };
    }
    return toCenterRange(range);
  }

  centerRanges(): Map<number, CenterRange> {
    return new Map(this.chunks.map((chunk) => [chunk.id, this.centerRange(chunk.id)]));
  }

  /** The text currently sitting in the chunk's region of the result. */
  private actualText(chunk: Chunk): string {
    return this.model.getValueInRange(toMonacoRange(this.model, this.centerRange(chunk.id)));
  }

  /** The text this chunk should hold for its state, i.e. what we last wrote there. */
  private expectedText(chunk: Chunk): string {
    const texts = this.texts.get(chunk.id);
    return texts ? joinLines(textForState(texts, chunk.state)) : '';
  }

  /**
   * Marks chunks the user typed into as manually edited. A hand-edited conflict counts as
   * decided — that is JetBrains' behavior, and it is what lets you write a blend of the
   * two sides rather than picking one.
   *
   * The test is "does this chunk still contain what we put there?", not "did an edit land
   * near it". Comparing positions means doing interval arithmetic against edit ranges, and
   * getting it slightly wrong marks a *neighbouring* conflict as resolved — which silently
   * clears the unresolved-conflict warning and lets a real conflict reach a commit.
   * Content can't drift like that: an edit outside a chunk moves it without changing it.
   */
  private watchUserEdits(): void {
    this.model.onDidChangeContent(() => {
      if (this.applying) {
        return;
      }
      for (const chunk of this.chunks) {
        if (chunk.state === 'manuallyEdited') {
          continue;
        }
        if (this.actualText(chunk) !== this.expectedText(chunk)) {
          chunk.state = 'manuallyEdited';
        }
      }
      // Even with no state change the text moved, so the layout must be recomputed.
      this.onChange();
    });
  }

  /** Whether an action is currently offered for this chunk. */
  can(chunk: Chunk, action: ChunkAction): boolean {
    return transition(chunk.kind, chunk.state, action) !== null;
  }

  /**
   * Applies a gutter action: rewrites the chunk's lines in the result and re-pins its
   * tracker. Returns false when the action isn't available.
   */
  apply(chunkId: number, action: Exclude<ChunkAction, 'manualEdit'>): boolean {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    const texts = chunk && this.texts.get(chunkId);
    if (!chunk || !texts) {
      return false;
    }
    const resolution = resolveAction(chunk, texts, action);
    if (!resolution) {
      return false;
    }

    const range = this.centerRange(chunkId);
    const model = this.model;
    this.applying = true;
    try {
      this.editor.executeEdits(EDIT_SOURCE, [
        { range: toMonacoRange(model, range), text: joinLines(resolution.lines) },
      ]);
      chunk.state = resolution.state;
      // Re-pin over exactly the text we just wrote. Stickiness decides how a decoration
      // reacts to edits at its edges, which is not a question with a right answer for a
      // whole-range replacement — so don't ask it.
      this.repin(chunk, range.start, resolution.lines.length);
    } finally {
      this.applying = false;
    }
    this.onChange();
    return true;
  }

  private repin(chunk: Chunk, startLine: number, lineCount: number): void {
    const existing = this.trackers.get(chunk.id);
    const next = this.model.deltaDecorations(existing ? [existing] : [], [
      {
        range: toMonacoRange(this.model, { start: startLine, end: startLine + lineCount }),
        options: { stickiness: STICKINESS },
      },
    ])[0];
    if (next) {
      this.trackers.set(chunk.id, next);
    }
  }

  /** Accepts a side on every chunk the predicate selects, as one undo step. */
  applyMany(pick: (chunk: Chunk) => Exclude<ChunkAction, 'manualEdit'> | null): number {
    let applied = 0;
    // Bottom-up: applying a chunk shifts everything below it, and trackers only settle
    // after the edit. Working upwards keeps every pending range valid.
    for (const chunk of [...this.chunks].reverse()) {
      const action = pick(chunk);
      if (action && this.apply(chunk.id, action)) {
        applied++;
      }
    }
    return applied;
  }

  acceptSide(chunkId: number, side: Side): boolean {
    return this.apply(chunkId, side === 'left' ? 'acceptLeft' : 'acceptRight');
  }

  result(): string {
    return this.model.getValue();
  }
}

/** Never let an edit at a chunk's edge silently swallow the neighbouring chunk. */
const STICKINESS: monaco.editor.TrackedRangeStickiness = 1; // NeverGrowsWhenTypingAtEdges

/**
 * Converts between the engine's line space and Monaco's — the one boundary where the two
 * disagree, kept in one place because every off-by-one here corrupts a merge.
 *
 * Engine line `i` is Monaco line `i + 1`, and a half-open range `[s, e)` becomes
 * `(s+1, 1) … (e+1, 1)`: from the start of the first line to the start of the line after
 * the last, so it spans whole lines *including* their newlines. An empty range stays
 * empty, which is what makes an insertion point insert rather than overwrite.
 *
 * The wrinkle is the final line. A document ending in a newline has a phantom empty last
 * line in Monaco (so `e+1` is a real line), but one that doesn't has no line to point at,
 * and `(e+1, 1)` is out of bounds. `validateRange` clamps that to the end of the last
 * line, which covers the same text — `toCenterRange` undoes the clamp on the way back.
 */
function toMonacoRange(model: monaco.editor.ITextModel, range: CenterRange): monaco.IRange {
  return model.validateRange({
    startLineNumber: range.start + 1,
    startColumn: 1,
    endLineNumber: range.end + 1,
    endColumn: 1,
  });
}

function toCenterRange(range: monaco.IRange): CenterRange {
  // A range clamped past the last line ends mid-line rather than at column 1; that still
  // means "through the end of this line", so the exclusive end is the line after it.
  const clamped = range.endColumn > 1;
  return {
    start: range.startLineNumber - 1,
    end: clamped ? range.endLineNumber : range.endLineNumber - 1,
  };
}
