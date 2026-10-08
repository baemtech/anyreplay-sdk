import type { AnyReplayNativePlugin } from '../src/definitions';

/** The native half, mocked the way the Swift and Kotlin code behave. Shared by the specs. */

export const KEY = 'ar_pk_live_0123456789abcdef01234567';
export const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 2]);

export interface MockNative extends AnyReplayNativePlugin {
  stored: string | null;
  writes: (string | null)[];
  fire: (event: 'pause' | 'resume') => void;
  pauseHandled: ReturnType<typeof vi.fn>;
}

export function mockNative(stored: string | null = null): MockNative {
  const listeners: Record<string, (() => void)[]> = {};
  const native = {
    stored,
    writes: [] as (string | null)[],
    getInfo: vi.fn(async () => ({ appId: 'com.example.shop', appVersion: '3.4.1', build: '341', deviceModel: 'iPhone15,2' })),
    readState: vi.fn(async () => ({ value: native.stored })),
    writeState: vi.fn(async ({ value }: { value: string | null }) => { native.stored = value; native.writes.push(value); }),
    pauseHandled: vi.fn(async () => undefined),
    addListener: vi.fn(async (event: string, listener: () => void) => {
      (listeners[event] ??= []).push(listener);
      return { remove: async () => undefined };
    }),
    fire: (event: 'pause' | 'resume') => { for (const listener of listeners[event] ?? []) listener(); },
  };
  return native as unknown as MockNative;
}

export function mockFetch() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/v1/ingest/events')) bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    if (href.endsWith('/known')) return new Response(JSON.stringify({ known: [] }), { status: 200 });
    if (href === 'https://localhost/assets/logo.png') return new Response(PNG, { status: 200 });
    return new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 });
  }));
  return bodies;
}

export const turns = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

