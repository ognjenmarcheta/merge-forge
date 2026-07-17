/**
 * The AI explanation drawer: a collapsible strip between the toolbar and the panes
 * that streams the model's markdown in. Rendering is a deliberately tiny subset —
 * escape everything first, then re-introduce only headings, bold, code, and lists —
 * so no third-party renderer enters the webview's CSP surface.
 */

export interface ExplainDrawer {
  openLoading(): void;
  appendDelta(text: string): void;
  finish(): void;
  showError(message: string, unconfigured: boolean): void;
  readonly isOpen: boolean;
}

export interface ExplainDrawerCallbacks {
  /** Fired when the user closes the drawer while a response is still streaming. */
  onCancel(): void;
  /** Fired from the "Set Anthropic API key" button in the unconfigured panel. */
  onSetup(): void;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Bold and code spans over already-escaped text. */
function inline(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Renders the supported markdown subset to an HTML string; input is untrusted. */
export function renderMarkdown(source: string): string {
  const parts: string[] = [];
  // Fenced blocks first, so their contents are never treated as markdown.
  const segments = source.split(/```[^\n]*\n?/);
  for (const [index, segment] of segments.entries()) {
    if (index % 2 === 1) {
      parts.push(`<pre><code>${escapeHtml(segment)}</code></pre>`);
      continue;
    }
    let listOpen = false;
    for (const line of segment.split('\n')) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const listItem = /^[-*]\s+(.*)$/.exec(line);
      if (listItem && !heading) {
        if (!listOpen) {
          parts.push('<ul>');
          listOpen = true;
        }
        parts.push(`<li>${inline(escapeHtml(listItem[1] ?? ''))}</li>`);
        continue;
      }
      if (listOpen) {
        parts.push('</ul>');
        listOpen = false;
      }
      if (heading) {
        const level = Math.min((heading[1] ?? '###').length + 2, 6);
        parts.push(`<h${level}>${inline(escapeHtml(heading[2] ?? ''))}</h${level}>`);
      } else if (line.trim() !== '') {
        parts.push(`<p>${inline(escapeHtml(line))}</p>`);
      }
    }
    if (listOpen) {
      parts.push('</ul>');
    }
  }
  return parts.join('');
}

export function createExplainDrawer(
  host: HTMLElement,
  callbacks: ExplainDrawerCallbacks,
): ExplainDrawer {
  const header = document.createElement('div');
  header.className = 'mf-explain-header';
  const title = document.createElement('span');
  title.className = 'mf-explain-title';
  title.textContent = '✦ AI explanation';
  const close = document.createElement('button');
  close.className = 'mf-explain-close';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close explanation');
  const closeGlyph = document.createElement('span');
  closeGlyph.className = 'codicon codicon-close';
  close.append(closeGlyph);
  header.append(title, close);

  const body = document.createElement('div');
  body.className = 'mf-explain-body';

  host.classList.add('mf-explain', 'mf-hidden');
  host.replaceChildren(header, body);

  let streaming = false;
  let accumulated = '';
  let stickToBottom = true;

  body.addEventListener('scroll', () => {
    stickToBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  });

  const render = (): void => {
    body.innerHTML = `${renderMarkdown(accumulated)}${
      streaming ? '<span class="mf-explain-cursor"></span>' : ''
    }`;
    if (stickToBottom) {
      body.scrollTop = body.scrollHeight;
    }
  };

  close.addEventListener('click', () => {
    if (streaming) {
      callbacks.onCancel();
      streaming = false;
    }
    host.classList.add('mf-hidden');
  });

  return {
    get isOpen() {
      return !host.classList.contains('mf-hidden');
    },
    openLoading() {
      streaming = true;
      accumulated = '';
      stickToBottom = true;
      host.classList.remove('mf-hidden');
      body.innerHTML =
        '<p class="mf-explain-waiting">Thinking<span class="mf-explain-cursor"></span></p>';
    },
    appendDelta(text) {
      if (!streaming) {
        return;
      }
      accumulated += text;
      render();
    },
    finish() {
      streaming = false;
      render();
    },
    showError(message, unconfigured) {
      streaming = false;
      host.classList.remove('mf-hidden');
      if (!unconfigured) {
        body.innerHTML = `<p class="mf-explain-error">${escapeHtml(message)}</p>`;
        return;
      }
      // Setup guidance rather than a bare failure: the two backends, one button.
      body.replaceChildren();
      const info = document.createElement('p');
      info.textContent =
        'No AI backend is available. In VS Code with GitHub Copilot this works out of the box; ' +
        'in Cursor (which does not expose its models to extensions) or without Copilot, ' +
        'set an Anthropic API key — it is stored in secure storage and used only for explanations.';
      const setup = document.createElement('button');
      setup.className = 'mf-explain-setup';
      setup.textContent = 'Set Anthropic API key';
      setup.addEventListener('click', callbacks.onSetup);
      body.append(info, setup);
    },
  };
}
