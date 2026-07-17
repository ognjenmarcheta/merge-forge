import type { Chunk } from '../src/merge/chunk';
import type { WhitespaceMode } from '../src/merge/engine';

/** How changed regions are emphasized: word-level detail or line backgrounds only. */
export type HighlightMode = 'words' | 'lines';

export interface ToolbarActions {
  /** Applies every non-conflicting change AND magic-resolves both-inserted conflicts. */
  applyAllNonConflicting: () => void;
  applyNonConflictingFrom: (side: 'left' | 'right') => void;
  next: () => void;
  previous: () => void;
  setWhitespace: (mode: WhitespaceMode) => void;
  setHighlight: (mode: HighlightMode) => void;
}

export interface FooterActions {
  acceptLeft: () => void;
  acceptRight: () => void;
  apply: () => void;
  cancel: () => void;
}

function button(label: string, title: string, onClick: () => void, primary = false): HTMLElement {
  const node = document.createElement('button');
  node.textContent = label;
  node.title = title;
  if (primary) {
    node.className = 'mf-primary';
  }
  node.addEventListener('click', onClick);
  return node;
}

function select<T extends string>(
  title: string,
  options: Array<[T, string]>,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const node = document.createElement('select');
  node.title = title;
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    node.append(option);
  }
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}

function separator(): HTMLElement {
  const node = document.createElement('span');
  node.className = 'mf-sep';
  return node;
}

export interface Toolbar {
  update: (chunks: readonly Chunk[], magicAvailable: boolean) => void;
  /** Reverts the whitespace dropdown, for when the user cancels the recompute. */
  setWhitespaceValue: (mode: WhitespaceMode) => void;
}

/** The JetBrains-style toolbar: nav, bulk-apply group, dropdowns, counter on the right. */
export function buildToolbar(
  host: HTMLElement,
  counter: HTMLElement,
  actions: ToolbarActions,
): Toolbar {
  const previous = button('↑', 'Previous change (Shift+F7)', actions.previous);
  const next = button('↓', 'Next change (F7)', actions.next);

  const applyLabel = document.createElement('span');
  applyLabel.className = 'mf-toolbar-label';
  applyLabel.textContent = 'Apply non-conflicting changes:';
  const fromLeft = button('⇥', 'Apply non-conflicting changes from the left side', () =>
    actions.applyNonConflictingFrom('left'),
  );
  const fromRight = button('⇤', 'Apply non-conflicting changes from the right side', () =>
    actions.applyNonConflictingFrom('right'),
  );
  // One button does the whole safe sweep: every one-sided change, plus the "magic"
  // conflicts where both sides simply added lines — hence the wand.
  const applyAll = button(
    '✦',
    'Apply all non-conflicting changes (including simple conflicts where both sides added lines)',
    actions.applyAllNonConflicting,
  );

  const whitespace = select<WhitespaceMode>(
    'How whitespace differences are treated when comparing',
    [
      ['exact', 'Do not ignore'],
      ['trim', 'Trim whitespaces'],
      ['ignoreAll', 'Ignore whitespaces'],
      ['ignoreAllAndEmpty', 'Ignore whitespaces and empty lines'],
    ],
    actions.setWhitespace,
  );
  const highlight = select<HighlightMode>(
    'How differences are highlighted',
    [
      ['words', 'Highlight words'],
      ['lines', 'Highlight lines'],
    ],
    actions.setHighlight,
  );

  host.append(
    previous,
    next,
    separator(),
    applyLabel,
    fromLeft,
    fromRight,
    applyAll,
    separator(),
    whitespace,
    highlight,
    counter,
  );

  return {
    update(chunks, magicAvailable) {
      const pending = chunks.filter((c) => c.state === 'initial');
      const nonConflicting = pending.filter((c) => c.kind !== 'conflict').length;
      const conflicts = pending.filter((c) => c.kind === 'conflict').length;

      applyAll.toggleAttribute('disabled', nonConflicting === 0 && !magicAvailable);
      fromLeft.toggleAttribute('disabled', nonConflicting === 0);
      fromRight.toggleAttribute('disabled', nonConflicting === 0);
      previous.toggleAttribute('disabled', chunks.length === 0);
      next.toggleAttribute('disabled', chunks.length === 0);

      counter.classList.toggle('mf-done', pending.length === 0);
      if (chunks.length === 0) {
        counter.textContent = 'No differences';
      } else if (pending.length === 0) {
        counter.textContent = '✓ All changes processed';
      } else {
        // JetBrains phrasing: "6 changes. 1 conflict."
        const parts = [`${pending.length} change${pending.length === 1 ? '' : 's'}.`];
        if (conflicts > 0) {
          parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}.`);
        }
        counter.textContent = parts.join(' ');
      }
    },
    setWhitespaceValue(mode) {
      whitespace.value = mode;
    },
  };
}

/** Footer per the screenshots: whole-file accepts on the left, Cancel/Apply on the right. */
export function buildFooter(host: HTMLElement, actions: FooterActions): void {
  const spacer = document.createElement('span');
  spacer.className = 'mf-spacer';
  host.append(
    button(
      'Accept Left',
      "Resolve the whole file with the left side's version",
      actions.acceptLeft,
    ),
    button(
      'Accept Right',
      "Resolve the whole file with the right side's version",
      actions.acceptRight,
    ),
    spacer,
    button('Cancel', 'Close without changing the conflicted file', actions.cancel),
    button('Apply', 'Save the result and mark the file resolved', actions.apply, true),
  );
}
