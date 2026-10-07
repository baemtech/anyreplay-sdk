import type { RecorderHandle } from '@anyreplay/browser';
import { tauri } from './tauri-mock';

/**
 * The Tauri entry with the browser SDK's `createRecorder` and Tauri's API both
 * replaced by stand-ins: what is checked is the options handed to the browser
 * SDK, and what happens on focus loss and close.
 */

const fake = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  shells: [] as unknown[],
  handles: [] as RecorderHandle[],
}));

vi.mock('@tauri-apps/api/app', async () => (await import('./tauri-mock')).appModule);
vi.mock('@tauri-apps/api/core', async () => (await import('./tauri-mock')).coreModule);
vi.mock('@tauri-apps/api/window', async () => (await import('./tauri-mock')).windowModule);
vi.mock('@anyreplay/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anyreplay/browser')>()),
  createRecorder: (options: Record<string, unknown>, shell?: unknown) => {
    fake.options.push(options);
    fake.shells.push(shell);
    const handle: RecorderHandle = {
      status: vi.fn(() => 'recording' as const),
      sessionId: vi.fn(() => 'session-1'),
      consent: vi.fn(),
      identify: vi.fn(),
      track: vi.fn(),
      trackError: vi.fn(),
      stop: vi.fn(),
      flush: vi.fn(async () => {}),
    };
    fake.handles.push(handle);
    return handle;
  },
}));

import { init, readAppInfo, tauriSetup, __resetForTests } from '../src/index';
import { SDK_NAME } from '../src/version';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

/** `init`'s wiring runs after `ready`; give its awaits a turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  tauri.reset();
  fake.options.length = 0;
  fake.shells.length = 0;
  fake.handles.length = 0;
});

afterEach(() => {
  __resetForTests();
  vi.restoreAllMocks();
});

describe('readAppInfo', () => {
  it('reads the identifier and version', async () => {
    expect(await readAppInfo()).toEqual({ appId: 'com.acme.notes', appVersion: '2.3.1' });
  });

  it('falls back to the name when it is a valid id and getIdentifier is missing (Tauri before 2.4)', async () => {
    tauri.identifier = new Error('Command get_identifier not found');
    tauri.name = 'acme-notes';
    expect(await readAppInfo()).toEqual({ appId: 'acme-notes', appVersion: '2.3.1' });
    tauri.name = 'Acme Notes';
    expect(await readAppInfo()).toEqual({ appVersion: '2.3.1' });
  });

  it('asks nothing outside Tauri', async () => {
    tauri.inside = false;
    expect(await readAppInfo()).toEqual({});
  });
});

describe('init', () => {
  it('hands the browser SDK the shell’s platform, SDK, app id, version and inline assets', async () => {
    const replay = init({ projectKey: KEY, maskAllTyping: true });
    await replay.ready;
    expect(fake.options).toEqual([expect.objectContaining({
      projectKey: KEY,
      maskAllTyping: true,
      appId: 'com.acme.notes',
      assets: 'inline',
    })]);
    expect(fake.shells).toEqual([{
      platform: 'tauri',
      sdk: { name: SDK_NAME, version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
      appVersion: '2.3.1',
    }]);
    // The shell's facts go to the browser SDK as the shell, never as options it would ignore.
    expect(fake.options[0]).not.toHaveProperty('platform');
    expect(fake.options[0]).not.toHaveProperty('appVersion');
    expect(fake.options[0]).not.toHaveProperty('flushOnBlur');
    expect(fake.options[0]).not.toHaveProperty('flushOnClose');
  });

  it('lets the options override what Tauri says', () => {
    const setup = tauriSetup({ projectKey: KEY, appId: 'com.acme.beta', appVersion: '3.0.0' }, { appId: 'com.acme.notes', appVersion: '2.3.1' });
    expect(setup.options).toMatchObject({ appId: 'com.acme.beta' });
    expect(setup.shell).toMatchObject({ appVersion: '3.0.0' });
  });

  it('queues calls until the app info arrives', async () => {
    const replay = init({ projectKey: KEY });
    replay.track('note_opened');
    expect(replay.status()).toBe('idle');
    await replay.ready;
    expect(fake.handles[0]!.track).toHaveBeenCalledWith('note_opened', undefined);
    expect(init({ projectKey: KEY })).toBe(replay);
  });

  it('warns, and still records, when there is no app id at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tauri.inside = false;
    const replay = init({ projectKey: KEY });
    await replay.ready;
    expect(fake.options[0]).not.toHaveProperty('appId');
    expect(warn.mock.calls[0]![0]).toMatch(/no appId/);
  });

  it('flushes when the window loses focus, not when it gains it', async () => {
    const replay = init({ projectKey: KEY });
    await replay.ready;
    await settle();
    expect(tauri.focusListeners).toHaveLength(1);
    tauri.focusListeners[0]!({ payload: true });
    expect(fake.handles[0]!.flush).not.toHaveBeenCalled();
    tauri.focusListeners[0]!({ payload: false });
    expect(fake.handles[0]!.flush).toHaveBeenCalledOnce();
  });

  it('falls back to the page’s blur when the focus event is not allowed', async () => {
    tauri.listenFails = true;
    const replay = init({ projectKey: KEY });
    await replay.ready;
    await settle();
    window.dispatchEvent(new Event('blur'));
    expect(fake.handles[0]!.flush).toHaveBeenCalledOnce();
  });

  it('leaves closing alone unless asked', async () => {
    const replay = init({ projectKey: KEY });
    await replay.ready;
    await settle();
    expect(tauri.closeListeners).toHaveLength(0);
  });

  it('flushes before the window closes when asked', async () => {
    const replay = init({ projectKey: KEY, flushOnClose: true });
    await replay.ready;
    await settle();
    expect(tauri.closeListeners).toHaveLength(1);
    await tauri.closeListeners[0]!({});
    expect(fake.handles[0]!.flush).toHaveBeenCalledOnce();
  });

  it('does not hold closing for longer than it allows', async () => {
    vi.useFakeTimers();
    try {
      const replay = init({ projectKey: KEY, flushOnClose: true });
      await replay.ready;
      await vi.advanceTimersByTimeAsync(0);
      (fake.handles[0]!.flush as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      let closed = false;
      void Promise.resolve(tauri.closeListeners[0]!({})).then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(1500);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
