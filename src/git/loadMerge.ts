import { basename, relative } from 'node:path';
import type { InitPayload } from '../protocol';
import { makeEolInfo, normalizeEol, type EolSetting } from '../merge/lineEndings';
import { detectOperation } from './repoContext';
import { readStages } from './stages';

/** Why a conflicted file cannot be opened in the three-pane editor. */
export type UnsupportedReason = 'deletedByThem' | 'deletedByUs';

export interface MergeInputs {
  payload: InitPayload;
  /** Set when the file is a delete/modify conflict, which has no meaningful three panes. */
  unsupported?: UnsupportedReason;
}

/**
 * Reads a conflicted file's stages and shapes them into what the webview needs.
 *
 * Two things happen here that the webview must not have to think about:
 *  - rebase/cherry-pick swap git's stage 2/3 so the left pane always means "yours"
 *  - all three texts are LF-normalized, with the original EOL recorded for the write-back
 */
export async function loadMergeInputs(
  repoRoot: string,
  relativePath: string,
  eolSetting: EolSetting,
): Promise<MergeInputs> {
  const [stages, operation] = await Promise.all([
    readStages(repoRoot, relativePath),
    detectOperation(repoRoot),
  ]);

  // git's stage 2 is "ours" and stage 3 is "theirs", but during a rebase those are the
  // upstream and your own commit respectively — flip them so "yours" stays on the left.
  const yours = operation.swapPresentation ? stages.theirs : stages.ours;
  const theirs = operation.swapPresentation ? stages.ours : stages.theirs;

  if (!yours) {
    return { payload: emptyPayload(relativePath), unsupported: 'deletedByUs' };
  }
  if (!theirs) {
    return { payload: emptyPayload(relativePath), unsupported: 'deletedByThem' };
  }

  const left = yours.toString('utf8');
  const right = theirs.toString('utf8');
  // A both-added conflict has no ancestor; an empty base makes every line an insertion.
  const base = stages.base?.toString('utf8') ?? '';

  return {
    payload: {
      filePath: relative(repoRoot, relativePath) || relativePath,
      languageId: 'plaintext',
      left: normalizeEol(left),
      base: normalizeEol(base),
      right: normalizeEol(right),
      labels: labelsFor(operation.kind),
      eol: makeEolInfo(left, base, right, eolSetting),
      settings: { autoApplyNonConflicting: false },
    },
  };
}

function labelsFor(kind: Awaited<ReturnType<typeof detectOperation>>['kind']): {
  left: string;
  right: string;
} {
  switch (kind) {
    case 'rebase':
      return { left: 'Yours (being rebased)', right: 'Theirs (upstream)' };
    case 'cherry-pick':
      return { left: 'Yours (being applied)', right: 'Theirs (current branch)' };
    default:
      return { left: 'Yours (local)', right: 'Theirs (incoming)' };
  }
}

function emptyPayload(relativePath: string): InitPayload {
  return {
    filePath: basename(relativePath),
    languageId: 'plaintext',
    left: '',
    base: '',
    right: '',
    labels: { left: 'Yours', right: 'Theirs' },
    eol: { left: 'lf', base: 'lf', right: 'lf', conflict: false, suggested: 'lf' },
    settings: { autoApplyNonConflicting: false },
  };
}
