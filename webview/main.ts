import './styles.css';
import type { Chunk } from '../src/merge/chunk';
import { computeChunks, splitLines, type WhitespaceMode } from '../src/merge/engine';
import { canAccept, canIgnore, canMagicResolve, nonConflictingAction } from '../src/merge/resolve';
import { wordHighlights } from '../src/merge/wordDiff';
import type {
  Eol,
  HostToWebviewMessage,
  InitPayload,
  MergeAction,
  WebviewToHostMessage,
} from '../src/protocol';
import { computeSegments, computeSpacers } from './alignment';
import { Connectors } from './connectors';
import { renderDecorations, type ChunkWordRanges } from './decorations';
import { createPanes, type Panes } from './editors';
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
}

let session: Session | undefined;
let cursor = -1;

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
  );
  redrawConnectors();
  session.toolbar.update(chunks, chunks.some(canMagicResolve));
  postState();
}

function redrawConnectors(): void {
  if (!session) {
    return;
  }
  const centerRanges = session.store.centerRanges();
  session.connectors.left.render(session.chunks, centerRanges);
  session.connectors.right.render(session.chunks, centerRanges);
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
  panes.center.revealLineInCenter(centerRange.start + 1);
  panes.left.revealLineInCenter(chunk.left.start + 1);
  panes.right.revealLineInCenter(chunk.right.start + 1);
  redrawConnectors();
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
      session.store.applyMany((chunk) => nonConflictingAction(chunk));
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
    onIgnore: (chunkId: number) => session?.store.apply(chunkId, 'ignore'),
    canAccept: (chunk: Chunk, side: 'left' | 'right') => canAccept(chunk, side),
    canIgnore: (chunk: Chunk) => canIgnore(chunk),
  };

  const toolbar = buildToolbar(layout.toolbar, layout.counter, {
    applyAllNonConflicting: () => session?.store.applyMany((chunk) => nonConflictingAction(chunk)),
    applyNonConflictingFrom: (side) =>
      session?.store.applyMany((chunk) => nonConflictingAction(chunk, side)),
    magicResolve: () => {
      session?.store.applyMany((chunk) => (canMagicResolve(chunk) ? 'acceptLeft' : null));
      session?.store.applyMany((chunk) =>
        chunk.bothInserted && chunk.state === 'appliedLeft' ? 'acceptRight' : null,
      );
    },
    next: () => navigate(1),
    previous: () => navigate(-1),
    setWhitespace: (mode) => void changeWhitespace(mode),
    setHighlight: (mode) => {
      if (session) {
        session.highlight = mode;
        refresh();
      }
    },
  });
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
  }
});

// Webviews swallow most keystrokes, so F7 is handled here as well as via a contributed
// keybinding — whichever gets there first.
window.addEventListener('keydown', (event) => {
  if (event.key === 'F7') {
    event.preventDefault();
    navigate(event.shiftKey ? -1 : 1);
  }
});

// The worker must exist before any editor is created, so `ready` — which triggers `init`,
// which builds the panes — waits for it.
void configureMonacoWorker((message) => post({ type: 'log', level: 'warn', message })).then(() =>
  post({ type: 'ready' }),
);
