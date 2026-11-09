import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectAppIdentity, plausibleAppId, withAppIdentity, type DetectedIdentity, type IdentityProbe } from '../src/app-identity.js';
import { init, stop } from '../src/native.js';
import type { Host } from '../src/recorder.js';
import { MemoryStore } from '../src/session.js';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

/** A probe over a fixed set of native modules; anything else is not linked. */
function probe(os: string, modules: Record<string, unknown>): IdentityProbe {
  return { os, module: (name) => modules[name] ?? null };
}

const expoApplication = (applicationId: string | null, nativeApplicationVersion: string | null = '2.3.0') =>
  ({ applicationId, nativeApplicationVersion });
const deviceInfo = { bundleId: 'com.example.bare', appVersion: '1.9.0' };
const embedded = {
  version: '5.0.0',
  ios: { bundleIdentifier: 'com.example.config' },
  android: { package: 'com.example.config.android' },
};

describe('detecting the app id', () => {
  it('reads expo-application first: the running binary is the truth', () => {
    expect(detectAppIdentity(probe('android', {
      ExpoApplication: expoApplication('com.example.shop'),
      RNDeviceInfo: deviceInfo,
      ExponentConstants: { executionEnvironment: 'bare', manifest: JSON.stringify(embedded) },
    }))).toEqual({ appId: 'com.example.shop', appVersion: '2.3.0', source: 'expo-application' });
  });

  it('falls back to react-native-device-info in a bare app', () => {
    expect(detectAppIdentity(probe('ios', { RNDeviceInfo: deviceInfo })))
      .toEqual({ appId: 'com.example.bare', appVersion: '1.9.0', source: 'react-native-device-info' });
  });

  it('reads device-info constants through getConstants() too (a TurboModule)', () => {
    const turbo = { getConstants: () => ({ bundleId: 'com.example.turbo', appVersion: '4.0' }) };
    expect(detectAppIdentity(probe('android', { RNDeviceInfo: turbo })))
      .toMatchObject({ appId: 'com.example.turbo', appVersion: '4.0' });
  });

  it('uses the embedded app config last, per platform, whether Android sends it as JSON text or iOS as an object', () => {
    expect(detectAppIdentity(probe('android', { ExponentConstants: { executionEnvironment: 'bare', manifest: JSON.stringify(embedded) } })))
      .toEqual({ appId: 'com.example.config.android', appVersion: '5.0.0', source: 'expo-constants' });
    expect(detectAppIdentity(probe('ios', { ExponentConstants: { executionEnvironment: 'standalone', manifest: embedded } })))
      .toEqual({ appId: 'com.example.config', appVersion: '5.0.0', source: 'expo-constants' });
  });

  it('skips a source with no usable id and takes the version from the first that has one', () => {
    expect(detectAppIdentity(probe('android', {
      ExpoApplication: expoApplication(null, null),
      RNDeviceInfo: { bundleId: 'unknown', appVersion: 'unknown' },
      ExponentConstants: { manifest: '{not json' },
    }))).toEqual({});
    expect(detectAppIdentity(probe('android', {
      ExpoApplication: expoApplication('', '7.1.0'),
      RNDeviceInfo: deviceInfo,
    }))).toEqual({ appId: 'com.example.bare', appVersion: '7.1.0', source: 'react-native-device-info' });
  });

  it('detects nothing in Expo Go, whose modules describe Expo Go', () => {
    // By the execution environment…
    expect(detectAppIdentity(probe('android', {
      ExponentConstants: { executionEnvironment: 'storeClient', manifest: JSON.stringify(embedded) },
      ExpoApplication: expoApplication('host.exp.exponent', '2.33.0'),
    }))).toEqual({ expoGo: true });
    // …by the older appOwnership…
    expect(detectAppIdentity(probe('ios', { ExponentConstants: { appOwnership: 'expo', manifest: embedded } })))
      .toEqual({ expoGo: true });
    // …and by Expo Go's own id even without expo-constants.
    expect(detectAppIdentity(probe('ios', { ExpoApplication: expoApplication('host.exp.Exponent') })))
      .toEqual({ expoGo: true });
  });

  it('finds nothing when no module is linked, and never throws', () => {
    expect(detectAppIdentity(probe('android', {}))).toEqual({});
    expect(detectAppIdentity({ os: 'ios', module: () => { throw new Error('no registry'); } })).toEqual({});
    const hostile = { get applicationId(): string { throw new Error('boom'); } };
    expect(detectAppIdentity(probe('ios', { ExpoApplication: hostile, RNDeviceInfo: deviceInfo })))
      .toMatchObject({ appId: 'com.example.bare' });
  });

  it('takes only ids ingest would accept', () => {
    expect(plausibleAppId(' com.example.app ')).toBe('com.example.app');
    for (const bad of ['', 'unknown', 'com example', '.com.example', 'host.exp.exponent', 'a'.repeat(300) + '.x', 42, null]) {
      expect(plausibleAppId(bad)).toBeUndefined();
    }
  });
});

describe('filling in the options', () => {
  const found: DetectedIdentity = { appId: 'com.example.detected', appVersion: '9.9.9', source: 'expo-application' };

  it('fills in what init was not given', () => {
    expect(withAppIdentity({ projectKey: KEY }, () => found)).toEqual({ projectKey: KEY, appId: 'com.example.detected', appVersion: '9.9.9' });
  });

  it('never replaces what init was given, even an invalid value (resolveOptions still refuses it)', () => {
    expect(withAppIdentity({ projectKey: KEY, appId: 'com.example.mine' }, () => found))
      .toEqual({ projectKey: KEY, appId: 'com.example.mine', appVersion: '9.9.9' });
    expect(withAppIdentity({ projectKey: KEY, appId: 'not an id' }, () => found).appId).toBe('not an id');
    const detect = vi.fn(() => found);
    withAppIdentity({ projectKey: KEY, appId: 'com.example.mine', appVersion: '1.0' }, detect);
    expect(detect).not.toHaveBeenCalled();
  });

  it('keeps the options as they were when nothing is found, warning once in debug', () => {
    const warn = vi.fn();
    expect(withAppIdentity({ projectKey: KEY }, () => ({}), warn)).toEqual({ projectKey: KEY });
    expect(warn).not.toHaveBeenCalled();
    withAppIdentity({ projectKey: KEY, debug: true }, () => { throw new Error('x'); }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/pass appId/);
  });

  it('says why in Expo Go', () => {
    const warn = vi.fn();
    withAppIdentity({ projectKey: KEY, debug: true }, () => ({ expoGo: true }), warn);
    expect(warn.mock.calls[0]![0]).toMatch(/Expo Go/);
  });
});

describe('init', () => {
  afterEach(() => stop());

  function host(identity?: DetectedIdentity) {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const timers: (() => void)[] = [];
    const h: Host = {
      now: () => 1_700_000_000_000,
      screen: () => ({ width: 390, height: 844 }),
      platform: () => ({ os: 'android', version: '34' }),
      locale: () => 'tr-TR',
      snapshot: () => ({ elements: new Map([[2, { id: 2, tag: 'View', rect: { x: 0, y: 0, width: 10, height: 10 }, children: [] }]]), rootId: 2 }),
      setInterval: (fn) => { timers.push(fn); return timers.length - 1; },
      clearInterval: () => {},
      fetch: (async (url: string, req: { body: string }) => {
        posts.push({ url: String(url), body: JSON.parse(req.body) });
        return { ok: true, status: 202, json: async () => ({}) } as Response;
      }) as unknown as typeof fetch,
      ...(identity ? { appIdentity: () => identity } : {}),
    };
    return { h, posts, flush: () => timers[1]?.() };
  }

  it('sends the detected id and version when init names neither', async () => {
    const f = host({ appId: 'com.example.detected', appVersion: '9.9.9' });
    await init({ projectKey: KEY, storage: new MemoryStore() }, f.h);
    f.flush();
    await vi.waitFor(() => expect(f.posts.length).toBeGreaterThan(0));
    expect(f.posts[0]!.body.appId).toBe('com.example.detected');
    expect((f.posts[0]!.body.meta as Record<string, unknown>).appVersion).toBe('9.9.9');
  });

  it('sends the id init was given over a detected one', async () => {
    const f = host({ appId: 'com.example.detected', appVersion: '9.9.9' });
    await init({ projectKey: KEY, appId: 'com.example.mine', storage: new MemoryStore() }, f.h);
    f.flush();
    await vi.waitFor(() => expect(f.posts.length).toBeGreaterThan(0));
    expect(f.posts[0]!.body.appId).toBe('com.example.mine');
  });

  it('sends no id when none was given or found (Expo Go), as before', async () => {
    const f = host({ expoGo: true });
    await init({ projectKey: KEY, storage: new MemoryStore() }, f.h);
    f.flush();
    await vi.waitFor(() => expect(f.posts.length).toBeGreaterThan(0));
    expect(f.posts[0]!.body).not.toHaveProperty('appId');
  });
});
