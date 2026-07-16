import type { Chunk } from '../src/merge/chunk';
import type { CenterRange } from './alignment';
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

function colorFor(chunk: Chunk): string {
  switch (chunk.kind) {
    case 'conflict':
      return 'rgba(199, 84, 80, 0.35)';
    case 'bothIdentical':
      return 'rgba(98, 150, 85, 0.30)';
    default:
      return 'rgba(58, 121, 189, 0.30)';
  }
}

/**
 * Draws the gutter strips between the panes: a filled shape linking each chunk's region
 * in the outer pane to its region in the result, plus its action buttons.
 *
 * This is one plain DOM layer we own rather than a set of Monaco widgets. Widgets would
 * fight Monaco's own layout for position, and could not draw the connecting shapes at all.
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

      shapes.push(this.shape(chunk, width, oTop, oBottom, cTop, cBottom));
      controls.push(...this.controlsFor(chunk, oTop));
    }

    this.svg.replaceChildren(...shapes);
    this.buttons.replaceChildren(...controls);
  }

  /** A band linking the chunk's rows in the outer pane to its rows in the result. */
  private shape(
    chunk: Chunk,
    width: number,
    oTop: number,
    oBottom: number,
    cTop: number,
    cBottom: number,
  ): SVGElement {
    const [xOuter, xCenter] = this.side === 'left' ? [0, width] : [width, 0];
    const path = document.createElementNS(SVG_NS, 'path');
    // A zero-height side (a pure insertion) still needs a visible edge to point at.
    const oB = Math.max(oBottom, oTop + 1);
    const cB = Math.max(cBottom, cTop + 1);
    path.setAttribute(
      'd',
      `M ${xOuter} ${oTop} L ${xCenter} ${cTop} L ${xCenter} ${cB} L ${xOuter} ${oB} Z`,
    );
    path.setAttribute('fill', colorFor(chunk));
    if (chunk.state !== 'initial') {
      path.setAttribute('opacity', '0.35');
    }
    return path;
  }

  private controlsFor(chunk: Chunk, top: number): HTMLElement[] {
    const controls: HTMLElement[] = [];
    if (this.callbacks.canAccept(chunk, this.side)) {
      // "»" pushes the left side rightwards into the result; "«" pulls the right side in.
      controls.push(
        this.button(this.side === 'left' ? '»' : '«', top, `Accept this change`, () =>
          this.callbacks.onAccept(chunk.id, this.side),
        ),
      );
    }
    if (this.callbacks.canIgnore(chunk)) {
      controls.push(
        this.button('×', top + 16, 'Ignore this change', () => this.callbacks.onIgnore(chunk.id)),
      );
    }
    return controls;
  }

  private button(label: string, top: number, title: string, onClick: () => void): HTMLElement {
    const button = document.createElement('button');
    button.className = 'mf-chunk-button';
    button.textContent = label;
    button.title = title;
    button.style.top = `${top}px`;
    button.addEventListener('click', onClick);
    return button;
  }
}
