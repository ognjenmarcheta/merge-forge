import './styles.css';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../src/protocol';

declare global {
  interface Window {
    __mergeForge: { workerUri: string };
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
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

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'init') {
    // M1 scaffold: render the round-tripped payload as proof of life.
    const pre = document.createElement('pre');
    pre.textContent = `merge-forge webview is alive\n\n${JSON.stringify(message.payload, null, 2)}`;
    app.replaceChildren(pre);
  }
});

post({ type: 'ready' });
