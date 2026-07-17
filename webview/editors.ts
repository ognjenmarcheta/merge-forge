import { monaco } from './monaco';
import { PANE_NAMES, type PaneName } from './panes';
import { THEME_NAME } from './theme';

export type Panes = Record<PaneName, monaco.editor.IStandaloneCodeEditor>;

/**
 * Options shared by all three panes.
 *
 * The alignment strategy pads panes with view zones so equal content occupies equal
 * vertical space; that only holds if every pane agrees on line height. Word wrap and
 * folding would break the line↔pixel correspondence, so both stay off.
 */
function paneOptions(readOnly: boolean): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    theme: THEME_NAME,
    readOnly,
    // Read-only panes shouldn't show a blinking cursor pretending they're editable.
    ...(readOnly ? { cursorBlinking: 'solid' as const, renderLineHighlight: 'none' as const } : {}),
    automaticLayout: true,
    wordWrap: 'off',
    folding: false,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    lineNumbersMinChars: 3,
    glyphMargin: false,
    // Chunk decorations paint scrollbar marks (WebStorm's right-edge stripes).
    overviewRulerLanes: 2,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: {
      // Only the center pane shows a vertical scrollbar; all three scroll together.
      vertical: readOnly ? 'hidden' : 'auto',
      horizontal: 'auto',
      handleMouseWheel: true,
    },
    fontSize: 12,
    lineHeight: 18,
  };
}

/** Creates the three editors and their models. Left and right are read-only, as in JetBrains. */
export function createPanes(
  hosts: Record<PaneName, HTMLElement>,
  content: Record<PaneName, string>,
  languageId: string,
): Panes {
  const make = (name: PaneName): monaco.editor.IStandaloneCodeEditor =>
    monaco.editor.create(hosts[name], {
      ...paneOptions(name !== 'center'),
      model: monaco.editor.createModel(content[name], languageId),
    });
  return { left: make('left'), center: make('center'), right: make('right') };
}

export function disposePanes(panes: Panes): void {
  for (const name of PANE_NAMES) {
    panes[name].getModel()?.dispose();
    panes[name].dispose();
  }
}
