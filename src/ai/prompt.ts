import type { ExplainRequest } from '../protocol';

/** Per-side character cap; conflicts larger than this are code dumps, not questions. */
export const SIDE_TEXT_CAP = 4000;

const SYSTEM_PROMPT = `You are a senior software engineer helping a teammate resolve a three-way Git merge.
For each conflict you receive the common ancestor (BASE) and the two branch versions.

For every conflict, under a "### Conflict N" heading:
1. Say in one or two sentences what each branch changed relative to BASE.
2. Explain why the two changes collide.
3. Suggest a concrete resolution — quote the merged code in a fenced block when it is short,
   or describe precisely which side to take and what to carry over from the other.

Be concise and practical. If the two sides are compatible (e.g. both added independent code),
say so and show how to combine them. Use markdown. Do not restate the inputs at length.
Cover every conflict you are given — never stop after the first one.`;

function fence(text: string): string {
  if (text === '') {
    return '(no lines — deleted)';
  }
  const capped =
    text.length > SIDE_TEXT_CAP ? `${text.slice(0, SIDE_TEXT_CAP)}\n…truncated…\n` : text;
  const body = capped.endsWith('\n') ? capped : `${capped}\n`;
  return `\`\`\`\n${body}\`\`\``;
}

/**
 * Builds the system/user prompt pair for a whole-file conflict explanation.
 * Pure and side-effect free so it can be unit-tested; providers own the transport.
 */
export function buildExplainPrompt(request: ExplainRequest): { system: string; user: string } {
  const lines: string[] = [
    `File: \`${request.filePath}\` (language: ${request.languageId})`,
    `Merging **${request.labels.right}** (theirs) into **${request.labels.left}** (yours).`,
    `The file has ${request.conflicts.length} unresolved conflict${
      request.conflicts.length === 1 ? '' : 's'
    }.`,
    '',
  ];
  for (const conflict of request.conflicts) {
    lines.push(
      `## Conflict ${conflict.index}`,
      '',
      'BASE (common ancestor):',
      fence(conflict.baseText),
      '',
      `YOURS (${request.labels.left}):`,
      fence(conflict.leftText),
      '',
      `THEIRS (${request.labels.right}):`,
      fence(conflict.rightText),
      '',
    );
  }
  // The explicit count keeps a model from quietly stopping after the first section.
  lines.push(
    `Your answer must contain exactly ${request.conflicts.length} "### Conflict" sections — ` +
      'one per conflict above, in order.',
  );
  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}
