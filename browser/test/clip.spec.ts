import {
  CLIP_CONFIG_TTL_MS, CLIP_COOLDOWN_MS, CLIP_SENT_KEY, CONFIG_KEY, ClipBuffer, clipInCooldown, loadProjectConfig,
  noteClipSent,
} from '../src/clip';
import type { RecordedEvent } from '../src/transport';
import { safeStorage } from '../src/visitor';

/**
 * The ring a crash clip is cut from, the five-minute cool-down and the
 * project's answer. What the ring has to get right: a clip always starts on a
 * snapshot, reaches at least 30 seconds back when it can, and never outgrows
 * its cap by keeping old segments.
 */

const meta = (t: number): RecordedEvent => ({ type: 4, timestamp: t, data: { href: 'https://shop.test/', width: 1, height: 1 } });
const snapshot = (t: number, pad = 0): RecordedEvent => ({ type: 2, timestamp: t, data: { node: { pad: 'x'.repeat(pad) } } });
const change = (t: number, pad = 0): RecordedEvent => ({ type: 3, timestamp: t, data: { source: 0, pad: 'x'.repeat(pad) } });

/** One checkout's worth: Meta, FullSnapshot, then a change every second until the next. */
function feed(buffer: ClipBuffer, from: number, to: number, every = 10_000, pad = 0): void {
  for (let t = from; t < to; t += 1000) {
    if ((t - from) % every === 0) {
      buffer.push(meta(t));
      buffer.push(snapshot(t, pad));
    } else {
      buffer.push(change(t, pad));
    }
  }
}

describe('ClipBuffer', () => {
  it('ignores events before its first snapshot', () => {
    const buffer = new ClipBuffer();
    buffer.push(change(0));
    expect(buffer.size).toBe(0);
    expect(buffer.take()).toEqual([]);
  });

  it('keeps the segments back to the one that starts at or before now − 30 s', () => {
    const buffer = new ClipBuffer();
    // Snapshots at 0, 10, 20 … 60 s; the last event at 69 s.
    feed(buffer, 0, 70_000);
    const events = buffer.take();
    // 69 − 30 = 39 s: the segment that started at 30 s is the newest that
    // covers it, so the clip starts there and runs 39 s.
    expect(events[0]).toMatchObject({ type: 4, timestamp: 30_000 });
    expect(events[1]!.type).toBe(2);
    expect(events[events.length - 1]!.timestamp).toBe(69_000);
  });

  it('does not drop a segment the window still needs', () => {
    const buffer = new ClipBuffer();
    feed(buffer, 0, 25_000);
    // At 24 s nothing is 30 s old yet: everything stays, from the first snapshot.
    expect(buffer.take()[0]!.timestamp).toBe(0);
  });

  it('drops the oldest segments over the byte cap, never the newest', () => {
    const asked = vi.fn();
    const buffer = new ClipBuffer({ windowMs: 30_000, maxBytes: 50_000 }, asked);
    // Each event carries ~2 KB, so one 10-second segment is ~20 KB.
    feed(buffer, 0, 30_000, 10_000, 2_000);
    expect(buffer.byteSize).toBeLessThanOrEqual(50_000);
    const events = buffer.take();
    expect(events[0]!.type).toBe(4);
    expect(events[0]!.timestamp).toBe(10_000);
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks once for an early snapshot when the newest segment alone is over the cap', () => {
    const asked = vi.fn();
    const buffer = new ClipBuffer({ windowMs: 30_000, maxBytes: 10_000 }, asked);
    feed(buffer, 0, 9_000, 10_000, 2_000);
    expect(asked).toHaveBeenCalledOnce();
    // Still all there: the newest segment holds the crash.
    expect(buffer.size).toBe(10);
    // The snapshot it asked for starts a segment, and the old one can go.
    buffer.push(meta(9_500));
    buffer.push(snapshot(9_500));
    expect(buffer.take()[0]!.timestamp).toBe(9_500);
  });

  it('empties itself on take', () => {
    const buffer = new ClipBuffer();
    feed(buffer, 0, 5_000);
    expect(buffer.take().length).toBeGreaterThan(0);
    expect(buffer.size).toBe(0);
    expect(buffer.byteSize).toBe(0);
  });
});

describe('the clip cool-down', () => {
  const local = safeStorage(() => localStorage);
  beforeEach(() => localStorage.clear());

  it('allows one clip per five minutes', () => {
    expect(clipInCooldown(local, 1_000_000)).toBe(false);
    noteClipSent(local, 1_000_000);
    expect(localStorage.getItem(CLIP_SENT_KEY)).toBe('1000000');
    expect(clipInCooldown(local, 1_000_000 + CLIP_COOLDOWN_MS - 1)).toBe(true);
    expect(clipInCooldown(local, 1_000_000 + CLIP_COOLDOWN_MS)).toBe(false);
  });

  it('ignores a stamp from the future or one it cannot read', () => {
    localStorage.setItem(CLIP_SENT_KEY, 'soon');
    expect(clipInCooldown(local, 1_000)).toBe(false);
    noteClipSent(local, 10_000);
    // A clock set back must not lock clips out until it catches up.
    expect(clipInCooldown(local, 5_000)).toBe(false);
  });
});

describe('loadProjectConfig', () => {
  const local = safeStorage(() => localStorage);
  const options = { ingestUrl: 'https://in.test', projectKey: 'ar_pk_live_0123456789abcdef01234567', appId: 'com.example.app' };

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('asks ingest with the key and the app id, without credentials, and keeps the answer', async () => {
    const fetchMock = answer({ crashClip: true, maskAllInputs: false });
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadProjectConfig(options, local, 1_000)).toEqual({ crashClip: true, maskAllInputs: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://in.test/v1/ingest/config?projectKey=ar_pk_live_0123456789abcdef01234567&appId=com.example.app');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY)!)).toMatchObject({ crashClip: true, maskAllInputs: false, t: 1_000 });
  });

  it('answers from the cache for ten minutes, then asks again', async () => {
    const fetchMock = answer({ crashClip: true, maskAllInputs: true });
    vi.stubGlobal('fetch', fetchMock);
    await loadProjectConfig(options, local, 0);
    await loadProjectConfig(options, local, CLIP_CONFIG_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledOnce();
    await loadProjectConfig(options, local, CLIP_CONFIG_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not use another project\'s cached answer', async () => {
    const fetchMock = answer({ crashClip: false, maskAllInputs: true });
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ k: 'other|', t: 0, crashClip: true, maskAllInputs: false }));
    expect(await loadProjectConfig(options, local, 1)).toEqual({ crashClip: false, maskAllInputs: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('has no answer on an error, a refusal or an ingest without the field — and reads a missing masking field as masked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await loadProjectConfig(options, local)).toBeUndefined();
    vi.stubGlobal('fetch', answer({ error: 'server' }, 503));
    expect(await loadProjectConfig(options, local)).toBeUndefined();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    vi.stubGlobal('fetch', answer({ maskAllInputs: false }));
    expect(await loadProjectConfig(options, local)).toBeUndefined();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    vi.stubGlobal('fetch', answer({ crashClip: true }));
    expect(await loadProjectConfig(options, local)).toEqual({ crashClip: true, maskAllInputs: true });
  });

  it('keeps a refusal as "no clips, masked" for as long as an answer, so a refused page does not ask on every load', async () => {
    const refused = answer({ error: 'app_not_allowed' }, 403);
    vi.stubGlobal('fetch', refused);
    expect(await loadProjectConfig(options, local, 0)).toBeUndefined();
    expect(await loadProjectConfig(options, local, 1_000)).toEqual({ crashClip: false, maskAllInputs: true });
    expect(refused).toHaveBeenCalledOnce();
  });
});
