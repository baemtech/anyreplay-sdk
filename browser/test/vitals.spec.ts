import { MAX_VITALS_REPORTS, VITALS_TAG, clsFrom, inpFrom, startVitals, type VitalsPayload } from '../src/vitals';

/**
 * Web vitals (vitals.ts). jsdom has no PerformanceObserver, so a fake one
 * stands in: each test hands it the entries a browser would have.
 */

type Entry = Partial<PerformanceEntry> & Record<string, unknown>;

class FakeObserver {
  static supportedEntryTypes = ['paint', 'largest-contentful-paint', 'layout-shift', 'event', 'first-input'];
  static all: FakeObserver[] = [];
  type = '';
  constructor(private readonly callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
    FakeObserver.all.push(this);
  }
  observe(init: { type: string }): void { this.type = init.type; }
  disconnect(): void { this.type = 'disconnected'; }
  takeRecords(): PerformanceEntry[] { return []; }
  static feed(type: string, entries: Entry[]): void {
    for (const observer of FakeObserver.all) {
      if (observer.type === type) observer.callback({ getEntries: () => entries as unknown as PerformanceEntry[] });
    }
  }
}

const hide = (): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
};

let sent: VitalsPayload[];
const emit = (tag: string, payload: VitalsPayload): void => {
  expect(tag).toBe(VITALS_TAG);
  sent.push(payload);
};

beforeEach(() => {
  sent = [];
  FakeObserver.all = [];
  vi.stubGlobal('PerformanceObserver', FakeObserver);
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
    { responseStart: 180.4, activationStart: 0 } as unknown as PerformanceEntry,
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('inpFrom', () => {
  it('is the worst interaction when there are few', () => {
    expect(inpFrom([40, 320, 96])).toBe(320);
  });
  it('ignores one in fifty as outliers on a busy page', () => {
    const durations = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(inpFrom(durations)).toBe(98);
  });
  it('is undefined without interactions', () => {
    expect(inpFrom([])).toBeUndefined();
  });
});

describe('clsFrom', () => {
  it('sums shifts within a window and keeps the worst window', () => {
    expect(clsFrom([
      { startTime: 0, value: 0.05 },
      { startTime: 500, value: 0.05 },
      // A gap of more than a second starts a new window.
      { startTime: 3000, value: 0.2 },
    ])).toBeCloseTo(0.2);
  });
  it('caps a window at five seconds', () => {
    const steady = Array.from({ length: 12 }, (_, i) => ({ startTime: i * 900, value: 0.02 }));
    expect(clsFrom(steady)).toBeLessThanOrEqual(0.12 + 1e-9);
  });
  it('ignores shifts right after input', () => {
    expect(clsFrom([{ startTime: 0, value: 0.4, hadRecentInput: true }])).toBe(0);
  });
});

describe('startVitals', () => {
  it('reports the five numbers when the page hides', () => {
    const handle = startVitals(emit);
    FakeObserver.feed('paint', [{ name: 'first-contentful-paint', startTime: 812.6 }]);
    FakeObserver.feed('largest-contentful-paint', [{ startTime: 1200 }, { startTime: 2405.2 }]);
    FakeObserver.feed('layout-shift', [{ startTime: 100, value: 0.031, hadRecentInput: false }]);
    FakeObserver.feed('event', [{ interactionId: 7, duration: 88 }, { interactionId: 7, duration: 120 }, { interactionId: 0, duration: 900 }]);
    hide();
    expect(sent).toEqual([{ url: expect.any(String), fcp: 813, lcp: 2405, cls: 0.031, inp: 120, ttfb: 180 }]);
    handle.stop();
  });

  it('stops LCP at the first input', () => {
    const handle = startVitals(emit);
    FakeObserver.feed('largest-contentful-paint', [{ startTime: 900 }]);
    window.dispatchEvent(new Event('pointerdown'));
    FakeObserver.feed('largest-contentful-paint', [{ startTime: 5000 }]);
    handle.report();
    expect(sent[0]?.lcp).toBe(900);
    handle.stop();
  });

  it('reports again only when a number grew, and at most ten times', () => {
    const handle = startVitals(emit);
    FakeObserver.feed('event', [{ interactionId: 1, duration: 64 }]);
    handle.report();
    handle.report();
    expect(sent).toHaveLength(1);
    for (let i = 2; i < 40; i += 1) {
      FakeObserver.feed('event', [{ interactionId: i, duration: 64 + i * 10 }]);
      handle.report();
    }
    expect(sent).toHaveLength(MAX_VITALS_REPORTS);
    handle.stop();
  });

  it('redacts the URL', () => {
    window.history.replaceState(null, '', '/reset?token=abc123');
    const handle = startVitals(emit);
    handle.report();
    expect(sent[0]?.url).toContain('token=%5Bredacted%5D');
    expect(sent[0]?.url).not.toContain('abc123');
    handle.stop();
    window.history.replaceState(null, '', '/');
  });

  it('reports nothing without PerformanceObserver or timing', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('PerformanceObserver', undefined);
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    const handle = startVitals(emit);
    handle.report();
    expect(sent).toEqual([]);
    handle.stop();
  });

  it('stops listening once stopped', () => {
    const handle = startVitals(emit);
    handle.stop();
    hide();
    expect(sent).toEqual([]);
    expect(FakeObserver.all.every((observer) => observer.type === 'disconnected')).toBe(true);
  });
});
