import './styles.css';
import { computeChunks } from '../src/merge/engine';
import type { HostToWebviewMessage, InitPayload, WebviewToHostMessage } from '../src/protocol';
import { computeSegments, computeSpacers, type CenterRange } from './alignment';
import { renderDecorations } from './decorations';
import { createPanes, type Panes } from './editors';
import { buildLayout } from './layout';
import type { monaco } from './monaco';
import { configureMonacoWorker } from './monaco';
import type { PaneName } from './panes';
import { syncScrolling } from './scrollSync';
import { applyTheme, watchTheme } from './theme';
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

/** Everything alive for one merge session. */
interface Session {
  panes: Panes;
  chunks: ReturnType<typeof computeChunks>;
  centerRanges: Map<number, CenterRange>;
  collections: Record<PaneName, monaco.editor.IEditorDecorationsCollection>;
  zoneIds: ReturnType<typeof emptyZoneIds>;
}

let session: Session | undefined;

/**
 * Recomputes layout from current state and repaints.
 *
 * Strictly one-way: state → segments (pure) → zones → decorations. Anything that changes
 * chunk state or the center document calls this rather than touching the editors itself,
 * which is what keeps the edit/alignment loop from feeding back on itself.
 */
function refresh(): void {
  if (!session) {
    return;
  }
  const { panes, chunks, centerRanges } = session;
  const totals = {
    left: panes.left.getModel()?.getLineCount() ?? 0,
    center: panes.center.getModel()?.getLineCount() ?? 0,
    right: panes.right.getModel()?.getLineCount() ?? 0,
  };
  const segments = computeSegments(chunks, centerRanges, totals);
  applySpacers(panes, computeSpacers(segments), session.zoneIds);
  renderDecorations(chunks, centerRanges, session.collections);
  postState();
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
      dirty: false,
    },
  });
}

function start(payload: InitPayload): void {
  const layout = buildLayout(app!, payload.labels, payload.filePath);
  applyTheme();
  watchTheme();

  // The center pane starts at the base revision — the last point both sides agreed on.
  const panes = createPanes(
    layout.hosts,
    { left: payload.left, center: payload.base, right: payload.right },
    payload.languageId,
  );

  const chunks = computeChunks(payload.base, payload.left, payload.right);
  session = {
    panes,
    chunks,
    centerRanges: new Map(chunks.map((c) => [c.id, { start: c.base.start, end: c.base.end }])),
    collections: {
      left: panes.left.createDecorationsCollection([]),
      center: panes.center.createDecorationsCollection([]),
      right: panes.right.createDecorationsCollection([]),
    },
    zoneIds: emptyZoneIds(),
  };

  syncScrolling(panes, () => {});
  refresh();

  if (payload.eol.conflict) {
    layout.banner.classList.remove('mf-hidden');
    layout.banner.textContent =
      `Line endings differ (yours: ${payload.eol.left.toUpperCase()}, ` +
      `theirs: ${payload.eol.right.toUpperCase()}). ` +
      `The result will be saved as ${payload.eol.suggested.toUpperCase()}.`;
  }

  layout.toolbar.append(layout.counter);
  layout.counter.textContent = `${chunks.length} change${chunks.length === 1 ? '' : 's'}`;
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'init' && !session) {
    start(message.payload);
  }
});

// The worker must be configured before any editor is created, so `ready` (which triggers
// `init`, which builds the panes) is only sent once that has settled.
void configureMonacoWorker((message) => post({ type: 'log', level: 'warn', message })).then(() =>
  post({ type: 'ready' }),
);
