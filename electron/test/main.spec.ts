/**
 * The main-process helper against a stand-in for Electron's `app`, `ipcMain`
 * and `BrowserWindow`. What it has to get right: the info a window asks for,
 * quitting held back only until the windows have flushed (or the timeout), and
 * a main-process crash reaching the focused window without changing how the
 * app handles it.
 */

const fake = vi.hoisted(() => {
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events');
  class FakeContents {
    static next = 1;
    id = FakeContents.next++;
    sent: [string, unknown][] = [];
    destroyed = false;
    onSend: ((channel: string, payload: unknown) => void) | null = null;
    isDestroyed() { return this.destroyed; }
    send(channel: string, payload: unknown) { this.sent.push([channel, payload]); this.onSend?.(channel, payload); }
  }
  class FakeWindow {
    webContents = new FakeContents();
    isDestroyed() { return false; }
  }
  const app = Object.assign(new Emitter(), {
    name: 'Acme Notes',
    getName: () => app.name,
    getVersion: () => '2.3.1',
    quit: vi.fn(),
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = Object.assign(new Emitter(), {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
  });
  const windows: FakeWindow[] = [];
  const BrowserWindow = {
    getAllWindows: () => windows,
    getFocusedWindow: () => windows[1] ?? null,
  };
  return { app, ipcMain, handlers, windows, BrowserWindow, FakeWindow };
});

vi.mock('electron', () => ({ app: fake.app, ipcMain: fake.ipcMain, BrowserWindow: fake.BrowserWindow }));

import { CHANNELS } from '../src/bridge';
import { describeError, resolveAppId, setupAnyReplay, type AnyReplayMainHandle } from '../src/main';

let handle: AnyReplayMainHandle | undefined;

beforeEach(() => {
  fake.windows.length = 0;
  fake.app.name = 'Acme Notes';
  fake.app.quit.mockClear();
});

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  vi.useRealTimers();
});

/** A before-quit event as Electron emits it. */
const quitEvent = () => ({ preventDefault: vi.fn() });

describe('resolveAppId', () => {
  it('keeps an explicit id and refuses a malformed one', () => {
    expect(resolveAppId('com.acme.notes', 'Acme Notes')).toBe('com.acme.notes');
    expect(resolveAppId('  com.acme.notes ', undefined)).toBe('com.acme.notes');
    expect(resolveAppId('not an id', 'Acme Notes')).toBeUndefined();
  });

  it('falls back to the app name, made into an id', () => {
    expect(resolveAppId(undefined, 'acme-notes')).toBe('acme-notes');
    expect(resolveAppId(undefined, 'Acme Notes')).toBe('acme-notes');
    expect(resolveAppId(undefined, '@acme/notes')).toBe('acme-notes');
    expect(resolveAppId(undefined, '')).toBeUndefined();
    expect(resolveAppId(undefined, '日本')).toBeUndefined();
  });
});

describe('setupAnyReplay', () => {
  it('answers a window with the app id and version', async () => {
    handle = setupAnyReplay({ appId: 'com.acme.notes' });
    expect(await fake.handlers.get(CHANNELS.appInfo)!()).toEqual({ appId: 'com.acme.notes', appVersion: '2.3.1' });
  });

  it('derives the id from the app name when none is given', async () => {
    handle = setupAnyReplay();
    expect(await fake.handlers.get(CHANNELS.appInfo)!()).toEqual({ appId: 'acme-notes', appVersion: '2.3.1' });
  });

  it('warns about, and leaves out, a malformed id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = setupAnyReplay({ appId: 'Acme Notes' });
    expect(warn).toHaveBeenCalledOnce();
    expect(await fake.handlers.get(CHANNELS.appInfo)!()).toEqual({ appVersion: '2.3.1' });
    warn.mockRestore();
  });

  it('holds quitting until every window has flushed', async () => {
    const a = new fake.FakeWindow();
    const b = new fake.FakeWindow();
    fake.windows.push(a, b);
    // Each window answers its flush request, as the preload does.
    for (const window of [a, b]) {
      window.webContents.onSend = (channel, id) => {
        if (channel !== CHANNELS.flush) return;
        setTimeout(() => fake.ipcMain.emit(CHANNELS.flushed, { sender: window.webContents }, id), 5);
      };
    }
    handle = setupAnyReplay({ appId: 'com.acme.notes', quitFlushTimeoutMs: 10_000 });

    const first = quitEvent();
    fake.app.emit('before-quit', first);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(a.webContents.sent[0]![0]).toBe(CHANNELS.flush);
    expect(fake.app.quit).not.toHaveBeenCalled();

    // Quitting again while the flush is under way does not ask twice.
    fake.app.emit('before-quit', quitEvent());
    expect(a.webContents.sent).toHaveLength(1);

    await vi.waitFor(() => expect(fake.app.quit).toHaveBeenCalledOnce());
    // The quit that follows goes through.
    const second = quitEvent();
    fake.app.emit('before-quit', second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('quits after the timeout when a window never answers', async () => {
    vi.useFakeTimers();
    fake.windows.push(new fake.FakeWindow());
    handle = setupAnyReplay({ quitFlushTimeoutMs: 1500 });
    fake.app.emit('before-quit', quitEvent());
    await vi.advanceTimersByTimeAsync(1499);
    expect(fake.app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.app.quit).toHaveBeenCalledOnce();
  });

  it('ignores an answer to some other flush', async () => {
    vi.useFakeTimers();
    const window = new fake.FakeWindow();
    fake.windows.push(window);
    handle = setupAnyReplay({ quitFlushTimeoutMs: 1000 });
    fake.app.emit('before-quit', quitEvent());
    fake.ipcMain.emit(CHANNELS.flushed, { sender: window.webContents }, 'stale-id');
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.app.quit).not.toHaveBeenCalled();
  });

  it('quits at once with no windows open, and not at all with the flush turned off', async () => {
    handle = setupAnyReplay();
    fake.app.emit('before-quit', quitEvent());
    await vi.waitFor(() => expect(fake.app.quit).toHaveBeenCalledOnce());
    handle.dispose();

    fake.app.quit.mockClear();
    handle = setupAnyReplay({ quitFlushTimeoutMs: 0 });
    const event = quitEvent();
    fake.app.emit('before-quit', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('forwards a main-process exception to the focused window, through the monitor only', () => {
    const before = process.listenerCount('uncaughtException');
    const background = new fake.FakeWindow();
    const focused = new fake.FakeWindow();
    fake.windows.push(background, focused);
    handle = setupAnyReplay();
    expect(process.listenerCount('uncaughtException')).toBe(before);

    (process.emit as (event: string, ...args: unknown[]) => boolean)('uncaughtExceptionMonitor', new TypeError('db is closed'), 'uncaughtException');
    expect(focused.webContents.sent).toEqual([[CHANNELS.mainError, expect.objectContaining({ name: 'TypeError', message: 'db is closed' })]]);
    expect(background.webContents.sent).toEqual([]);
  });

  it('can be told not to forward errors, and removes what it installed', () => {
    const monitors = process.listenerCount('uncaughtExceptionMonitor');
    handle = setupAnyReplay({ forwardMainErrors: false });
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitors);
    handle.dispose();
    handle = setupAnyReplay();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitors + 1);
    expect(fake.app.listenerCount('before-quit')).toBe(1);
    handle.dispose();
    handle = undefined;
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitors);
    expect(fake.app.listenerCount('before-quit')).toBe(0);
    expect(fake.handlers.has(CHANNELS.appInfo)).toBe(false);
  });
});

describe('describeError', () => {
  it('sends strings only', () => {
    expect(describeError('boom')).toEqual({ message: 'boom' });
    const error = new RangeError('too far');
    expect(describeError(error)).toEqual({ name: 'RangeError', message: 'too far', stack: error.stack });
  });
});
