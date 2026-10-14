/**
 * The preload helper against a stand-in for `contextBridge` and
 * `ipcRenderer`: what it exposes, and that it answers the main process.
 */

const fake = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  return {
    exposed: new Map<string, unknown>(),
    listeners,
    invoke: vi.fn(),
    send: vi.fn(),
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { fake.exposed.set(key, api); } },
  ipcRenderer: {
    invoke: fake.invoke,
    send: fake.send,
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { fake.listeners.set(channel, listener); },
  },
}));

import { BRIDGE_KEY, CHANNELS, type AnyReplayBridge } from '../src/bridge';
import { exposeAnyReplay } from '../src/preload';

const setIsolated = (value: boolean): void => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value });
};

beforeEach(() => {
  fake.exposed.clear();
  fake.listeners.clear();
  fake.invoke.mockReset();
  fake.send.mockReset();
  setIsolated(true);
});

afterEach(() => {
  delete (process as { contextIsolated?: boolean }).contextIsolated;
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY];
});

const bridge = (): AnyReplayBridge => fake.exposed.get(BRIDGE_KEY) as AnyReplayBridge;

describe('exposeAnyReplay', () => {
  it('exposes a narrow API through contextBridge', () => {
    exposeAnyReplay();
    expect(Object.keys(bridge()).sort()).toEqual(['appInfo', 'onFlushRequest', 'onMainError', 'version']);
    expect(bridge().version).toBe(1);
    expect([...fake.listeners.keys()].sort()).toEqual([CHANNELS.flush, CHANNELS.mainError].sort());
  });

  it('asks the main process for the app info', async () => {
    fake.invoke.mockResolvedValue({ appId: 'com.acme.notes', appVersion: '2.3.1' });
    exposeAnyReplay();
    expect(await bridge().appInfo()).toEqual({ appId: 'com.acme.notes', appVersion: '2.3.1' });
    expect(fake.invoke).toHaveBeenCalledWith(CHANNELS.appInfo);
  });

  it('answers with nothing when the main process was not set up', async () => {
    fake.invoke.mockRejectedValue(new Error("No handler registered for 'anyreplay:app-info'"));
    exposeAnyReplay();
    expect(await bridge().appInfo()).toEqual({});
  });

  it('runs the page’s flush and then answers with the same id', async () => {
    exposeAnyReplay();
    const order: string[] = [];
    bridge().onFlushRequest(async () => { order.push('flush'); });
    fake.send.mockImplementation(() => order.push('answer'));
    fake.listeners.get(CHANNELS.flush)!({}, 'q-1');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(CHANNELS.flushed, 'q-1'));
    expect(order).toEqual(['flush', 'answer']);
  });

  it('answers even when there is no recorder, or its flush fails', async () => {
    exposeAnyReplay();
    fake.listeners.get(CHANNELS.flush)!({}, 'q-1');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(CHANNELS.flushed, 'q-1'));
    bridge().onFlushRequest(() => { throw new Error('offline'); });
    fake.listeners.get(CHANNELS.flush)!({}, 'q-2');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(CHANNELS.flushed, 'q-2'));
  });

  it('hands main-process errors to the page’s listener', () => {
    exposeAnyReplay();
    const seen: unknown[] = [];
    bridge().onMainError((error) => seen.push(error));
    fake.listeners.get(CHANNELS.mainError)!({}, { message: 'db is closed' });
    expect(seen).toEqual([{ message: 'db is closed' }]);
  });

  it('puts the API on window directly without context isolation', () => {
    setIsolated(false);
    exposeAnyReplay();
    expect(fake.exposed.size).toBe(0);
    expect((globalThis as Record<string, unknown>)[BRIDGE_KEY]).toMatchObject({ version: 1 });
  });
});
