import type { RecorderHandle } from '@anyreplay/browser';

/**
 * The renderer entry with the browser SDK's `createRecorder` replaced by a
 * stand-in, so what is checked is exactly the options this SDK hands it and
 * what it does with the handle it gets back.
 */

const fake = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  shells: [] as unknown[],
  handles: [] as RecorderHandle[],
}));

vi.mock('@anyreplay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anyreplay/browser')>();
  return {
    ...actual,
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
  };
});

import { BRIDGE_KEY, electronSetup, init, mainError, __resetForTests, type AnyReplayBridge, type MainErrorMessage } from '../src/index';
import { SDK_NAME } from '../src/version';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

function installBridge(info: { appId?: string; appVersion?: string } = { appId: 'com.acme.notes', appVersion: '2.3.1' }) {
  const state = {
    flush: null as (() => Promise<void> | void) | null,
    error: null as ((error: MainErrorMessage) => void) | null,
  };
  const bridge: AnyReplayBridge = {
    version: 1,
    appInfo: vi.fn(async () => info),
    onFlushRequest: (flush) => { state.flush = flush; },
    onMainError: (listener) => { state.error = listener; },
  };
  (globalThis as Record<string, unknown>)[BRIDGE_KEY] = bridge;
  return state;
}

beforeEach(() => {
  fake.options.length = 0;
  fake.shells.length = 0;
  fake.handles.length = 0;
});

afterEach(() => {
  __resetForTests();
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY];
  vi.restoreAllMocks();
});

describe('init', () => {
  it('hands the browser SDK the shell’s platform, SDK, app id, version and inline assets', async () => {
    installBridge();
    const replay = init({ projectKey: KEY, maskAllInputs: true });
    await replay.ready;
    expect(fake.options).toEqual([expect.objectContaining({
      projectKey: KEY,
      maskAllInputs: true,
      appId: 'com.acme.notes',
      assets: 'inline',
    })]);
    expect(fake.shells).toEqual([{
      platform: 'electron',
      sdk: { name: SDK_NAME, version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
      appVersion: '2.3.1',
    }]);
    // The shell's facts go to the browser SDK as the shell, never as options it would ignore.
    expect(fake.options[0]).not.toHaveProperty('platform');
    expect(fake.options[0]).not.toHaveProperty('appVersion');
    expect(fake.options[0]).not.toHaveProperty('flushOnBlur');
    expect(fake.options[0]).not.toHaveProperty('deviceModel');
  });

  it('lets the options override what the main process says', async () => {
    installBridge();
    const replay = init({ projectKey: KEY, appId: 'com.acme.notes.beta', appVersion: '3.0.0-beta.1' });
    await replay.ready;
    expect(fake.options[0]).toMatchObject({ appId: 'com.acme.notes.beta' });
    expect(fake.shells[0]).toMatchObject({ appVersion: '3.0.0-beta.1' });
  });

  it('queues calls made before the app info arrives, in order', async () => {
    installBridge();
    const replay = init({ projectKey: KEY, requireConsent: true });
    expect(replay.status()).toBe('idle');
    expect(replay.sessionId()).toBeNull();
    replay.consent(true);
    replay.identify({ userId: 'u-1' });
    replay.track('note_opened', { words: 3 });
    await replay.ready;
    const handle = fake.handles[0]!;
    expect(handle.consent).toHaveBeenCalledWith(true);
    expect(handle.identify).toHaveBeenCalledWith({ userId: 'u-1' });
    expect(handle.track).toHaveBeenCalledWith('note_opened', { words: 3 });
    expect(replay.status()).toBe('recording');
    expect(replay.sessionId()).toBe('session-1');
  });

  it('returns the same handle on a second call', () => {
    installBridge();
    expect(init({ projectKey: KEY })).toBe(init({ projectKey: KEY }));
  });

  it('never starts when stopped before the app info arrives', async () => {
    installBridge();
    const replay = init({ projectKey: KEY });
    replay.stop();
    await replay.ready;
    expect(fake.handles).toHaveLength(0);
    expect(replay.status()).toBe('stopped');
  });

  it('records without the bridge, and says the app id is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replay = init({ projectKey: KEY });
    await replay.ready;
    expect(fake.options[0]).not.toHaveProperty('appId');
    expect(fake.shells[0]).toMatchObject({ platform: 'electron' });
    expect(warn.mock.calls[0]![0]).toMatch(/no appId/);
  });

  it('does not throw into the app over a malformed app id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installBridge({ appId: 'Acme Notes' });
    const replay = init({ projectKey: KEY });
    await replay.ready;
    expect(fake.handles).toHaveLength(0);
    expect(String(warn.mock.calls.at(-1)?.[1])).toMatch(/app identifier/);
  });

  it('flushes when the main process asks, and when the window loses focus', async () => {
    const state = installBridge();
    const replay = init({ projectKey: KEY });
    await replay.ready;
    const handle = fake.handles[0]!;
    await state.flush!();
    expect(handle.flush).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('blur'));
    expect(handle.flush).toHaveBeenCalledTimes(2);
  });

  it('can leave focus changes alone', async () => {
    installBridge();
    const replay = init({ projectKey: KEY, flushOnBlur: false });
    await replay.ready;
    window.dispatchEvent(new Event('blur'));
    expect(fake.handles[0]!.flush).not.toHaveBeenCalled();
  });

  it('records a main-process error as the window would its own', async () => {
    const state = installBridge();
    const replay = init({ projectKey: KEY });
    await replay.ready;
    state.error!({ name: 'TypeError', message: 'sync failed for ayse@example.com', stack: 'TypeError: sync failed\n    at sync (main.js:10:5)' });
    const handle = fake.handles[0]!;
    expect(handle.track).not.toHaveBeenCalled();
    const [error] = (handle.trackError as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // Redacting is the browser SDK's job (trackError); this hands it the error intact.
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'TypeError', message: 'sync failed for ayse@example.com' });
    expect((error as Error).stack).toContain('main.js:10:5');
  });
});

describe('mainError', () => {
  it('copes with a message that is not one', () => {
    expect(mainError(undefined)).toMatchObject({ name: 'Error', message: 'error' });
    expect(mainError({ message: 'x', name: '' })).toMatchObject({ name: 'Error', message: 'x' });
  });
});

describe('electronSetup', () => {
  it('clips a long version to what ingest keeps', () => {
    expect(electronSetup({ projectKey: KEY }, { appId: 'com.acme.notes', appVersion: '1'.repeat(60) }).shell.appVersion).toHaveLength(40);
  });

  it('lets an app that loads a public site keep references to it', () => {
    expect(electronSetup({ projectKey: KEY, assets: 'reference' }, {}).options.assets).toBe('reference');
  });
});
