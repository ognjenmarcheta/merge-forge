import './styles.css';
import type { Chunk } from '../src/merge/chunk';
import { computeChunks, splitLines, type WhitespaceMode } from '../src/merge/engine';
import { chunkTexts, nonConflictingAction, sideControls } from '../src/merge/resolve';
import { wordHighlights } from '../src/merge/wordDiff';
import type {
  Eol,
  ExplainRequest,
  HostToWebviewMessage,
  InitPayload,
  MergeAction,
  WebviewToHostMessage,
} from '../src/protocol';
import { baseLineNumbers, computeSegments, computeSpacers } from './alignment';
import { Connectors } from './connectors';
import { renderDecorations, type ChunkWordRanges } from './decorations';
import { createPanes, type Panes } from './editors';
import { createExplainDrawer, type ExplainDrawer } from './explainDrawer';
import { buildLayout } from './layout';
import { configureMonacoWorker } from './monaco';
import type { monaco } from './monaco';
import type { PaneName } from './panes';
import { syncScrolling } from './scrollSync';
import { ChunkStore } from './state';
import { applyTheme, watchTheme } from './theme';
import { buildFooter, buildToolbar, type HighlightMode, type Toolbar } from './toolbar';
import { applySpacers, emptyZoneIds } from './viewZones';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

function post(message: WebviewToHostMessage): void {
  vscodeApi.postMessage(message);
}

const app = document.getElementById('app');
if (!app) {
  throw new Error('missing #app root');
}

interface Session {
  payload: InitPayload;
  layout: ReturnType<typeof buildLayout>;
  panes: Panes;
  store: ChunkStore;
  chunks: Chunk[];
  wordRanges: Map<number, ChunkWordRanges>;
  whitespace: WhitespaceMode;
  highlight: HighlightMode;
  connectors: { left: Connectors; right: Connectors };
  collections: Record<PaneName, monaco.editor.IEditorDecorationsCollection>;
  zoneIds: ReturnType<typeof emptyZoneIds>;
  toolbar: Toolbar;
  zone: Eol;
  /** Navigation emphasis: the chunk you last jumped to, and the transient arrival flash. */
  currentChunkId: number | undefined;
  flashChunkId: number | undefined;
  /** Chunk under the pointer (band or controls); never snapshotted. */
  hoverChunkId: number | undefined;
}

let session: Session | undefined;
let drawer: ExplainDrawer | undefined;
let cursor = -1;
let flashTimer: number | undefined;
/** Last applied base↔center mapping, so the margin only repaints when ranges move. */
let lineNumbersSignature = '';

/** Word-level emphasis per chunk, computed once — base and side texts never change. */
function computeWordRanges(chunks: readonly Chunk[], payload: InitPayload) {
  const map = new Map<number, ChunkWordRanges>();
  const baseLines = splitLines(payload.base);
  const leftLines = splitLines(payload.left);
  const rightLines = splitLines(payload.right);
  for (const chunk of chunks) {
    const baseSlice = baseLines.slice(chunk.base.start, chunk.base.end);
    map.set(chunk.id, {
      left:
        chunk.leftSubtype === 'modified'
          ? wordHighlights(baseSlice, leftLines.slice(chunk.left.start, chunk.left.end))
          : [],
      right:
        chunk.rightSubtype === 'modified'
          ? wordHighlights(baseSlice, rightLines.slice(chunk.right.start, chunk.right.end))
          : [],
    });
  }
  return map;
}

/**
 * Recomputes layout and repaints from current state.
 *
 * Strictly one-way — state → segments → zones → decorations → connectors — and everything
 * that mutates state routes through here rather than touching editors directly. That is
 * what stops the edit → track → align cycle from feeding back on itself.
 */
function refresh(): void {
  if (!session) {
    return;
  }
  const { panes, chunks, store } = session;
  const centerRanges = store.centerRanges();
  const totals = {
    left: panes.left.getModel()?.getLineCount() ?? 0,
    center: panes.center.getModel()?.getLineCount() ?? 0,
    right: panes.right.getModel()?.getLineCount() ?? 0,
  };
  applySpacers(
    panes,
    computeSpacers(computeSegments(chunks, centerRanges, totals)),
    session.zoneIds,
  );
  renderDecorations(
    chunks,
    centerRanges,
    session.collections,
    session.highlight === 'words' ? session.wordRanges : undefined,
    {
      currentChunkId: session.currentChunkId,
      flashChunkId: session.flashChunkId,
      hoverChunkId: session.hoverChunkId,
    },
  );
  redrawConnectors();
  updateBaseLineNumbers(centerRanges);
  session.toolbar.update(chunks);
  // WebStorm's completion card: floats over the result once nothing needs deciding,
  // and disappears again the moment any chunk reopens (e.g. via undo).
  const allProcessed = chunks.length > 0 && chunks.every((c) => c.state !== 'initial');
  session.layout.doneCard.classList.toggle('mf-hidden', !allProcessed);
  postState();
}

/**
 * JetBrains shows the original (base) line number next to the current one in the
 * result pane. Rebuilding the renderer forces a margin repaint, so it only happens
 * when a chunk's mapping actually moved — not on hover or flash refreshes.
 */
function updateBaseLineNumbers(centerRanges: ReadonlyMap<number, { start: number; end: number }>) {
  if (!session) {
    return;
  }
  const signature = session.chunks
    .map((chunk) => {
      const range = centerRanges.get(chunk.id);
      return `${chunk.id}:${chunk.base.start}-${chunk.base.end}:${range?.start}-${range?.end}`;
    })
    .join(',');
  if (signature === lineNumbersSignature) {
    return;
  }
  lineNumbersSignature = signature;
  const baseTotal = splitLines(session.payload.base).length;
  const baseFor = baseLineNumbers(session.chunks, centerRanges, baseTotal);
  session.panes.center.updateOptions({
    lineNumbersMinChars: 7,
    lineNumbers: (lineNumber: number) => {
      const base = baseFor(lineNumber);
      return base === '' ? String(lineNumber) : `${base} ${lineNumber}`;
    },
  });
}

function redrawConnectors(): void {
  if (!session) {
    return;
  }
  const centerRanges = session.store.centerRanges();
  const emphasis = {
    currentChunkId: session.currentChunkId,
    flashChunkId: session.flashChunkId,
    hoverChunkId: session.hoverChunkId,
  };
  session.connectors.left.render(session.chunks, centerRanges, emphasis);
  session.connectors.right.render(session.chunks, centerRanges, emphasis);
}

function postState(): void {
  if (!session) {
    return;
  }
  const { chunks } = session;
  post({
    type: 'state',
    payload: {
      totalChunks: chunks.length,
      unresolvedConflicts: chunks.filter((c) => c.kind === 'conflict' && c.state === 'initial')
        .length,
      pendingChanges: chunks.filter((c) => c.state === 'initial').length,
      dirty: chunks.some((c) => c.state !== 'initial'),
    },
  });
}

/** Moves to the next or previous unresolved change and centers it in every pane. */
function navigate(direction: 1 | -1): void {
  if (!session || session.chunks.length === 0) {
    return;
  }
  const { chunks, panes, store } = session;
  const candidates = chunks.filter((c) => c.state === 'initial');
  const pool = candidates.length > 0 ? candidates : chunks;
  cursor = (cursor + direction + pool.length) % pool.length;
  const chunk = pool[cursor];
  if (!chunk) {
    return;
  }
  const centerRange = store.centerRange(chunk.id);
  // ScrollType.Smooth (0) lets the eye follow the jump; the arrival flash marks the
  // destination, then the chunk keeps its "current" outline until the next jump.
  const SMOOTH = 0;
  panes.center.revealLineInCenter(centerRange.start + 1, SMOOTH);
  panes.left.revealLineInCenter(chunk.left.start + 1, SMOOTH);
  panes.right.revealLineInCenter(chunk.right.start + 1, SMOOTH);
  session.currentChunkId = chunk.id;
  session.flashChunkId = chunk.id;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    if (session) {
      session.flashChunkId = undefined;
      refresh();
    }
  }, 750);
  refresh();
}

/** Advances to the next pending chunk, or stays put when nothing is left to decide. */
function navigateToNextUnresolved(): void {
  if (session?.chunks.some((chunk) => chunk.state === 'initial')) {
    navigate(1);
  }
}

/**
 * Runs a resolution action and, when it settles the chunk, hops to the next pending one
 * — accept, accept, accept down the file without reaching for the mouse.
 */
function resolveAndAdvance(run: () => void, chunkId: number): void {
  run();
  const chunk = session?.chunks.find((c) => c.id === chunkId);
  if (chunk && chunk.state !== 'initial') {
    navigateToNextUnresolved();
  }
}

/**
 * Applies every change only one side made. Strictly non-conflicting: a conflict —
 * including two sides inserting different versions of the same new code — never has an
 * automatic answer, and concatenating "both added" variants duplicates real functions
 * (found in the field). Red stays red until a human decides.
 */
function applyAllSafe(): void {
  session?.store.applyMany((chunk) => nonConflictingAction(chunk));
}

function runAction(action: MergeAction): void {
  if (!session) {
    return;
  }
  switch (action) {
    case 'nextChange':
      navigate(1);
      break;
    case 'prevChange':
      navigate(-1);
      break;
    case 'applyAllNonConflicting':
      applyAllSafe();
      break;
    case 'requestApply':
      requestApply();
      break;
  }
}

function requestApply(): void {
  if (!session) {
    return;
  }
  post({ type: 'apply', payload: { content: session.store.result(), eol: session.zone } });
}

/** Ships the unresolved conflicts (base + both sides) to the host for an AI explanation. */
function requestExplain(): void {
  if (!session || !drawer) {
    return;
  }
  const { payload } = session;
  const conflicts = session.chunks.filter((c) => c.kind === 'conflict' && c.state === 'initial');
  if (conflicts.length === 0) {
    return;
  }
  const request: ExplainRequest = {
    filePath: payload.filePath,
    languageId: payload.languageId,
    labels: payload.labels,
    conflicts: conflicts.map((chunk, position) => {
      // Lines are terminator-inclusive, so joining with '' reconstructs the exact text.
      const texts = chunkTexts(chunk, payload.base, payload.left, payload.right);
      return {
        index: position + 1,
        baseText: texts.base.join(''),
        leftText: texts.left.join(''),
        rightText: texts.right.join(''),
      };
    }),
  };
  drawer.openLoading();
  post({ type: 'explain', payload: request });
}

/**
 * Builds (or rebuilds) the chunk model over the existing panes. Rebuilding happens when
 * the whitespace mode changes: the center resets to base and every decision starts over,
 * because chunks computed under one mode don't map onto ranges computed under another.
 */
function buildSession(whitespace: WhitespaceMode): void {
  if (!session) {
    return;
  }
  session.store.dispose();
  session.panes.center.getModel()?.setValue(session.payload.base);

  const chunks = computeChunks(session.payload.base, session.payload.left, session.payload.right, {
    whitespace,
  });
  session.chunks = chunks;
  session.whitespace = whitespace;
  session.wordRanges = computeWordRanges(chunks, session.payload);
  session.store = new ChunkStore(
    chunks,
    session.panes.center,
    session.payload.base,
    session.payload.left,
    session.payload.right,
    () => refresh(),
  );
  cursor = -1;
  session.currentChunkId = undefined;
  session.flashChunkId = undefined;
  lineNumbersSignature = '';
  refresh();
}

/** Asks an inline yes/no in the confirm bar; resolves false on cancel. */
function confirmInBar(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bar = session?.layout.confirmBar;
    if (!bar) {
      resolve(false);
      return;
    }
    const finish = (answer: boolean) => {
      bar.classList.add('mf-hidden');
      bar.replaceChildren();
      resolve(answer);
    };
    const text = document.createElement('span');
    text.textContent = message;
    const yes = document.createElement('button');
    yes.textContent = 'Continue';
    yes.addEventListener('click', () => finish(true));
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    no.addEventListener('click', () => finish(false));
    bar.replaceChildren(text, yes, no);
    bar.classList.remove('mf-hidden');
  });
}

async function changeWhitespace(mode: WhitespaceMode): Promise<void> {
  if (!session || mode === session.whitespace) {
    return;
  }
  const hasProgress = session.chunks.some((chunk) => chunk.state !== 'initial');
  if (hasProgress) {
    const proceed = await confirmInBar(
      'Changing whitespace handling recomputes the changes and resets your progress in this file.',
    );
    if (!proceed) {
      session.toolbar.setWhitespaceValue(session.whitespace);
      return;
    }
  }
  buildSession(mode);
}

function start(payload: InitPayload): void {
  const layout = buildLayout(app!, payload.labels, payload.filePath);
  applyTheme();
  watchTheme();

  // The result starts at the base revision — the last state both sides agreed on — so
  // every difference is an explicit decision rather than a silent default to one side.
  const panes = createPanes(
    layout.hosts,
    { left: payload.left, center: payload.base, right: payload.right },
    payload.languageId,
  );

  const chunks = computeChunks(payload.base, payload.left, payload.right);
  const store = new ChunkStore(
    chunks,
    panes.center,
    payload.base,
    payload.left,
    payload.right,
    () => refresh(),
  );

  const callbacks = {
    onAccept: (chunkId: number, side: 'left' | 'right') => session?.store.acceptSide(chunkId, side),
    onDismiss: (chunkId: number, side: 'left' | 'right') =>
      session?.store.dismissSide(chunkId, side),
    controls: (chunk: Chunk) => sideControls(chunk),
    onHover: (chunkId: number | undefined) => {
      if (session && session.hoverChunkId !== chunkId) {
        session.hoverChunkId = chunkId;
        refresh();
      }
    },
  };

  drawer = createExplainDrawer(layout.explainHost, {
    onCancel: () => post({ type: 'explainCancel' }),
    onSetup: () => post({ type: 'openAiSetup' }),
  });

  const toolbar = buildToolbar(layout.toolbar, layout.counter, {
    applyAllNonConflicting: applyAllSafe,
    applyNonConflictingFrom: (side) =>
      session?.store.applyMany((chunk) => nonConflictingAction(chunk, side)),
    next: () => navigate(1),
    previous: () => navigate(-1),
    setWhitespace: (mode) => void changeWhitespace(mode),
    setHighlight: (mode) => {
      if (session) {
        session.highlight = mode;
        refresh();
      }
    },
    explain: requestExplain,
  });
  layout.doneAction.addEventListener('click', requestApply);
  buildFooter(layout.footer, {
    acceptLeft: () => session?.store.acceptAll('left', session.payload.left),
    acceptRight: () => session?.store.acceptAll('right', session.payload.right),
    apply: requestApply,
    cancel: () => post({ type: 'abort' }),
  });

  session = {
    payload,
    layout,
    panes,
    store,
    chunks,
    wordRanges: computeWordRanges(chunks, payload),
    whitespace: 'exact',
    highlight: 'words',
    connectors: {
      left: new Connectors(layout.leftStrip, 'left', panes, callbacks),
      right: new Connectors(layout.rightStrip, 'right', panes, callbacks),
    },
    collections: {
      left: panes.left.createDecorationsCollection([]),
      center: panes.center.createDecorationsCollection([]),
      right: panes.right.createDecorationsCollection([]),
    },
    zoneIds: emptyZoneIds(),
    toolbar,
    zone: payload.eol.suggested,
    currentChunkId: undefined,
    flashChunkId: undefined,
    hoverChunkId: undefined,
  };

  syncScrolling(panes, redrawConnectors);
  window.addEventListener('resize', redrawConnectors);

  if (payload.eol.conflict) {
    showEolBanner(layout.banner, payload);
  }
  if (payload.settings.autoApplyNonConflicting) {
    store.applyMany((chunk) => nonConflictingAction(chunk));
  }
  refresh();
  // Land on the first pending change immediately — flash and outline included.
  navigateToNextUnresolved();

  // Debug handle for the dev harness (dev/harness*.html); inert inside a real webview.
  (window as unknown as Record<string, unknown>).__mfSession = session;
}

/** Lets the user choose the result's line ending when the sides disagree. */
function showEolBanner(banner: HTMLElement, payload: InitPayload): void {
  banner.classList.remove('mf-hidden');
  const text = document.createElement('span');
  text.textContent =
    `Line endings differ — yours: ${payload.eol.left.toUpperCase()}, ` +
    `theirs: ${payload.eol.right.toUpperCase()}. Save the result as:`;
  banner.append(text);

  for (const eol of ['lf', 'crlf'] as const) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'mf-eol';
    radio.checked = payload.eol.suggested === eol;
    radio.addEventListener('change', () => {
      if (session) {
        session.zone = eol;
      }
    });
    label.append(radio, document.createTextNode(` ${eol.toUpperCase()}`));
    banner.append(label);
  }
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'init' && !session) {
    start(message.payload);
  } else if (message.type === 'runAction') {
    runAction(message.action);
  } else if (message.type === 'explainDelta') {
    drawer?.appendDelta(message.text);
  } else if (message.type === 'explainDone') {
    drawer?.finish();
  } else if (message.type === 'explainError') {
    drawer?.showError(message.message, message.unconfigured === true);
  }
});

// Webviews swallow most keystrokes, so navigation and resolution keys are handled here
// (capture phase, so Monaco doesn't eat them first). F7 also exists as a contributed
// keybinding — whichever gets there first wins.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'F7') {
      event.preventDefault();
      navigate(event.shiftKey ? -1 : 1);
      return;
    }
    // Alt+←/→ take the corresponding side of the CURRENT chunk, then auto-advance.
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const id = session?.currentChunkId;
      const chunk = session?.chunks.find((c) => c.id === id);
      if (id === undefined || !chunk) {
        return;
      }
      const side = event.key === 'ArrowLeft' ? 'left' : 'right';
      const offered = sideControls(chunk);
      if (side === 'left' ? offered.acceptLeft : offered.acceptRight) {
        event.preventDefault();
        event.stopPropagation();
        resolveAndAdvance(() => session?.store.acceptSide(id, side), id);
      }
    }
  },
  { capture: true },
);

// The worker must exist before any editor is created, so `ready` — which triggers `init`,
// which builds the panes — waits for it.
void configureMonacoWorker((message) => post({ type: 'log', level: 'warn', message })).then(() =>
  post({ type: 'ready' }),
);
