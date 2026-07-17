import type { PaneName } from './panes';

export interface Layout {
  root: HTMLElement;
  banner: HTMLElement;
  /** A second banner row for inline confirmations (e.g. whitespace-mode reset). */
  confirmBar: HTMLElement;
  toolbar: HTMLElement;
  counter: HTMLElement;
  hosts: Record<PaneName, HTMLElement>;
  /** Gutter strips: `leftStrip` sits between the left and center panes. */
  leftStrip: HTMLElement;
  rightStrip: HTMLElement;
  footer: HTMLElement;
  /** Floating "all changes processed" card over the result pane. */
  doneCard: HTMLElement;
  doneAction: HTMLElement;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function pane(title: string): { pane: HTMLElement; host: HTMLElement } {
  const wrapper = element('div', 'mf-pane');
  const header = element('div', 'mf-pane-header', title);
  const host = element('div', 'mf-editor');
  wrapper.append(header, host);
  return { pane: wrapper, host };
}

/** Builds the static chrome: header, three panes, two gutter strips, footer. */
export function buildLayout(
  root: HTMLElement,
  labels: { left: string; right: string },
  filePath: string,
): Layout {
  const banner = element('div', 'mf-banner mf-hidden');
  const confirmBar = element('div', 'mf-banner mf-hidden');
  const toolbar = element('div', 'mf-toolbar');
  const counter = element('div', 'mf-counter');
  const panes = element('div', 'mf-panes');
  const footer = element('div', 'mf-footer');

  // JetBrains headers: the sides say where the changes come from; the middle is yours.
  const left = pane(`Changes from ${labels.left}`);
  const center = pane(`Result — ${filePath}`);
  const right = pane(`Changes from ${labels.right}`);
  const leftStrip = element('div', 'mf-strip');
  const rightStrip = element('div', 'mf-strip');

  // WebStorm's completion indicator, floating over the result pane once nothing is left.
  const doneCard = element('div', 'mf-done-card mf-hidden');
  const doneTitle = element('div', 'mf-done-title', '✓ All changes have been processed');
  const doneAction = element('a', 'mf-done-action', 'Save changes and finish merging');
  doneCard.append(doneTitle, doneAction);
  center.pane.classList.add('mf-pane-center');
  center.pane.append(doneCard);

  panes.append(left.pane, leftStrip, center.pane, rightStrip, right.pane);
  root.replaceChildren(banner, confirmBar, toolbar, panes, footer);

  return {
    root,
    banner,
    confirmBar,
    toolbar,
    counter,
    hosts: { left: left.host, center: center.host, right: right.host },
    leftStrip,
    rightStrip,
    footer,
    doneCard,
    doneAction,
  };
}
