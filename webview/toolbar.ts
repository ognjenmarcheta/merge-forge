import type { Chunk } from '../src/merge/chunk';

export interface ToolbarActions {
  applyAllNonConflicting: () => void;
  applyNonConflictingFrom: (side: 'left' | 'right') => void;
  magicResolve: () => void;
  next: () => void;
  previous: () => void;
}

export interface FooterActions {
  apply: () => void;
  abort: () => void;
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

export interface Toolbar {
  /** Reflects progress and enables/disables what currently makes sense. */
  update: (chunks: readonly Chunk[], magicAvailable: boolean) => void;
}

export function buildToolbar(
  host: HTMLElement,
  counter: HTMLElement,
  actions: ToolbarActions,
): Toolbar {
  const applyAll = button(
    '⤢ Apply All Non-Conflicting',
    'Resolve every change only one side made',
    actions.applyAllNonConflicting,
  );
  const fromLeft = button('⇥ From Left', 'Apply non-conflicting changes from the left only', () =>
    actions.applyNonConflictingFrom('left'),
  );
  const fromRight = button(
    '⇤ From Right',
    'Apply non-conflicting changes from the right only',
    () => actions.applyNonConflictingFrom('right'),
  );
  const magic = button(
    '✦ Magic Resolve',
    'Keep both sides where each simply added lines',
    actions.magicResolve,
  );
  const previous = button('↑', 'Previous change (Shift+F7)', actions.previous);
  const next = button('↓', 'Next change (F7)', actions.next);

  host.append(applyAll, fromLeft, fromRight, magic, previous, next, counter);

  return {
    update(chunks, magicAvailable) {
      const pending = chunks.filter((c) => c.state === 'initial');
      const nonConflicting = pending.filter((c) => c.kind !== 'conflict').length;
      const conflicts = pending.filter((c) => c.kind === 'conflict').length;

      applyAll.toggleAttribute('disabled', nonConflicting === 0);
      fromLeft.toggleAttribute('disabled', nonConflicting === 0);
      fromRight.toggleAttribute('disabled', nonConflicting === 0);
      magic.toggleAttribute('disabled', !magicAvailable);
      previous.toggleAttribute('disabled', chunks.length === 0);
      next.toggleAttribute('disabled', chunks.length === 0);

      counter.classList.toggle('mf-done', pending.length === 0);
      if (chunks.length === 0) {
        counter.textContent = 'No differences';
      } else if (pending.length === 0) {
        counter.textContent = '✓ All changes processed';
      } else {
        const parts = [`${pending.length} of ${chunks.length} remaining`];
        if (conflicts > 0) {
          parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
        }
        counter.textContent = parts.join(' · ');
      }
    },
  };
}

export function buildFooter(host: HTMLElement, actions: FooterActions): void {
  host.append(
    button('Abort', 'Close without changing the conflicted file', actions.abort),
    button('Apply', 'Save the result and mark the file resolved', actions.apply, true),
  );
}
