import { JSDOM } from 'jsdom';
import type { Environment } from 'vitest/environments';
import { populateGlobal } from 'vitest/environments';

/**
 * jsdom, at the URL a desktop shell loads its page from.
 *
 * A packaged Electron window is `file://…/index.html` and a Tauri one is
 * `tauri://localhost`. Both are opaque origins to the URL standard, and jsdom
 * refuses `localStorage` and `sessionStorage` to an opaque origin — but the
 * shells do not: Electron and Tauri give such a page working, persistent
 * storage, which is where the browser SDK keeps the visitor and session ids.
 * So this is Vitest's own jsdom environment with that one refusal taken out.
 */
const environment: Environment = {
  name: 'app-origin',
  transformMode: 'web',
  async setup(global, { jsdom = {} }) {
    const { url = 'file:///index.html' } = jsdom as { url?: string };
    const dom = new JSDOM('<!DOCTYPE html>', { url, pretendToBeVisual: true, runScripts: 'dangerously' });
    const window = dom.window as unknown as { _localStorage: Storage; _sessionStorage: Storage };
    Object.defineProperty(dom.window, 'localStorage', { configurable: true, enumerable: true, get: () => window._localStorage });
    Object.defineProperty(dom.window, 'sessionStorage', { configurable: true, enumerable: true, get: () => window._sessionStorage });

    const { keys, originals } = populateGlobal(global, dom.window, { bindFunctions: true });
    return {
      teardown(target) {
        dom.window.close();
        keys.forEach((key) => delete target[key]);
        originals.forEach((value, key) => { target[key] = value; });
      },
    };
  },
};

export default environment;
