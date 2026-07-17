import type { Chunk } from '../src/merge/chunk';
import type { CenterRange } from './alignment';
import { visualOf } from './alignment';
import type { Panes } from './editors';
import type { monaco } from './monaco';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Which side of the result a strip sits on: the left strip connects left ↔ center. */
export type StripSide = 'left' | 'right';

export interface ConnectorCallbacks {
  onAccept: (chunkId: number, side: StripSide) => void;
  onIgnore: (chunkId: number) => void;
  canAccept: (chunk: Chunk, side: StripSide) => boolean;
  canIgnore: (chunk: Chunk) => boolean;
}

/** Fill and edge colours per chunk family — the same palette the line fills use. */
const COLORS: Record<ReturnType<typeof visualOf>, { fill: string; edge: string }> = {
  conf: { fill: 'rgba(199, 84, 80, 0.30)', edge: 'rgba(199, 84, 80, 0.75)' },
  add: { fill: 'rgba(98, 150, 85, 0.28)', edge: 'rgba(98, 150, 85, 0.75)' },
  del: { fill: 'rgba(128, 128, 128, 0.25)', edge: 'rgba(128, 128, 128, 0.7)' },
  mod: { fill: 'rgba(58, 121, 189, 0.26)', edge: 'rgba(58, 121, 189, 0.75)' },
};

/**
 * Draws the gutter strips between the panes: an S-curved band linking each chunk's rows
 * in the outer pane to its rows in the result (the WebStorm connector shape), plus the
 * chunk's » « × controls at its first line.
 *
 * This is one plain DOM layer we own rather than a set of Monaco widgets. Widgets would
 * fight Monaco's own layout for position, and could not draw the connecting bands at all.
 */
export class Connectors {
  private readonly svg: SVGSVGElement;
  private readonly buttons: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly side: StripSide,
    private readonly panes: Panes,
    private readonly callbacks: ConnectorCallbacks,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.buttons = document.createElement('div');
    this.buttons.className = 'mf-strip-buttons';
    this.host.append(this.svg, this.buttons);
  }

  /** Pixel offset of an editor line from the top of the visible area. */
  private yOf(editor: monaco.editor.IStandaloneCodeEditor, line: number): number {
    return editor.getTopForLineNumber(line + 1) - editor.getScrollTop();
  }

  render(chunks: readonly Chunk[], centerRanges: ReadonlyMap<number, CenterRange>): void {
    const outer = this.panes[this.side];
    const center = this.panes.center;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    const shapes: SVGElement[] = [];
    const controls: HTMLElement[] = [];

    for (const chunk of chunks) {
      const outerRange = this.side === 'left' ? chunk.left : chunk.right;
      const centerRange = centerRanges.get(chunk.id);
      if (!centerRange) {
        continue;
      }
      // Nothing marks this chunk on this side, so there is nothing to connect.
      if (outerRange.start === outerRange.end && centerRange.start === centerRange.end) {
        continue;
      }

      const oTop = this.yOf(outer, outerRange.start);
      const oBottom = this.yOf(outer, Math.max(outerRange.start, outerRange.end));
      const cTop = this.yOf(center, centerRange.start);
      const cBottom = this.yOf(center, Math.max(centerRange.start, centerRange.end));

      if (Math.max(oBottom, cBottom) < 0 || Math.min(oTop, cTop) > height) {
        continue; // fully scrolled out of view
      }

      shapes.push(this.band(chunk, width, oTop, oBottom, cTop, cBottom));
      controls.push(...this.controlsFor(chunk, oTop));
    }

    this.svg.replaceChildren(...shapes);
    this.buttons.replaceChildren(...controls);
  }

  /**
   * The WebStorm connector: an S-curved band from the chunk's rows in the outer pane to
   * its rows in the result. Horizontal-tangent beziers give the smooth flow; a collapsed
   * end (a pure insertion or deletion) narrows to a near-line pointing into the gap.
   */
  private band(
    chunk: Chunk,
    width: number,
    oTop: number,
    oBottom: number,
    cTop: number,
    cBottom: number,
  ): SVGElement {
    const [xOuter, xCenter] = this.side === 'left' ? [0, width] : [width, 0];
    const mid = width / 2;
    // A zero-height side still needs a visible edge to point at.
    const oB = Math.max(oBottom, oTop + 1.5);
    const cB = Math.max(cBottom, cTop + 1.5);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      `M ${xOuter} ${oTop} ` +
        `C ${mid} ${oTop} ${mid} ${cTop} ${xCenter} ${cTop} ` +
        `L ${xCenter} ${cB} ` +
        `C ${mid} ${cB} ${mid} ${oB} ${xOuter} ${oB} Z`,
    );
    const colors = COLORS[visualOf(chunk)];
    path.setAttribute('fill', colors.fill);
    path.setAttribute('stroke', colors.edge);
    path.setAttribute('stroke-width', '1');
    if (chunk.state !== 'initial') {
      path.setAttribute('opacity', '0.3');
    }
    return path;
  }

  private controlsFor(chunk: Chunk, top: number): HTMLElement[] {
    const row = document.createElement('div');
    row.className = `mf-chunk-controls mf-controls-${this.side}`;
    // Sit the pair just inside the chunk's first row, WebStorm-style.
    row.style.top = `${Math.max(0, top + 1)}px`;

    if (this.callbacks.canAccept(chunk, this.side)) {
      // "»" pushes the left side into the result; "«" pulls the right side in.
      row.append(
        this.glyph(this.side === 'left' ? '»' : '«', 'Accept this change', () =>
          this.callbacks.onAccept(chunk.id, this.side),
        ),
      );
    }
    if (this.callbacks.canIgnore(chunk)) {
      row.append(this.glyph('×', 'Ignore this change', () => this.callbacks.onIgnore(chunk.id)));
    }
    return row.childElementCount > 0 ? [row] : [];
  }

  private glyph(label: string, title: string, onClick: () => void): HTMLElement {
    const button = document.createElement('button');
    button.className = 'mf-chunk-glyph';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }
}
