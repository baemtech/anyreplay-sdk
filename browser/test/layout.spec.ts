import { checkRecording } from '@anyreplay/shared/conformance';
import { createRecorder, type RecorderHandle } from '../src/recorder';
import {
  LAYOUT_TAG, NAVIGATION_DELAY_MS, addClickOffset, layoutChanged, measureLayout, watchLayout, type LayoutPayload,
} from '../src/layout';

/**
 * What heatmaps need from a page that rrweb does not record (contract §4.2):
 * the page's size, and where inside its element a click landed.
 */

const KEY = 'ar_pk_live_0123456789abcdef01234567';

/** jsdom lays nothing out: every height is 0 unless a test says otherwise. */
function setDocumentHeight(height: number): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => height });
}

function boxOf(element: Element, box: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () => ({
    ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box,
  }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '<main><button id="buy">Buy</button></main>';
  setDocumentHeight(3000);
});

afterEach(() => {
  // Back to jsdom's own (prototype) getter.
  delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('measureLayout', () => {
  it('reports the document and the viewport in whole CSS pixels', () => {
    expect(measureLayout()).toEqual({ w: window.innerWidth, h: 3000, vw: window.innerWidth, vh: window.innerHeight });
  });

  it('measures a page that scrolls its body rather than the window', () => {
    setDocumentHeight(window.innerHeight);
    Object.defineProperty(document.body, 'scrollHeight', { configurable: true, get: () => 5200 });
    expect(measureLayout()?.h).toBe(5200);
    delete (document.body as unknown as Record<string, unknown>).scrollHeight;
  });

  it('is never shorter than the screen', () => {
    setDocumentHeight(0);
    expect(measureLayout()?.h).toBe(window.innerHeight);
  });
});

describe('layoutChanged', () => {
  const base: LayoutPayload = { w: 1280, h: 4000, vw: 1280, vh: 800 };
  it('ignores a height that moved by less than 64 px or 5%', () => {
    expect(layoutChanged(base, { ...base, h: 4050 })).toBe(false);
    expect(layoutChanged(base, { ...base, h: 4150 })).toBe(false);
    expect(layoutChanged(base, { ...base, h: 4200 })).toBe(true);
    expect(layoutChanged({ ...base, h: 900 }, { ...base, h: 950 })).toBe(false);
    expect(layoutChanged({ ...base, h: 900 }, { ...base, h: 970 })).toBe(true);
  });

  it('always reports a new viewport, and a first measurement', () => {
    expect(layoutChanged(base, { ...base, vh: 700 })).toBe(true);
    expect(layoutChanged(null, base)).toBe(true);
  });
});

describe('watchLayout', () => {
  it('sends on demand, then only when the page grows enough to matter', () => {
    vi.useFakeTimers();
    const sent: LayoutPayload[] = [];
    const watch = watchLayout((payload) => sent.push(payload));
    watch.force();
    vi.advanceTimersByTime(1);
    expect(sent.map((p) => p.h)).toEqual([3000]);

    setDocumentHeight(3050);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);

    setDocumentHeight(4800);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1500);
    expect(sent.map((p) => p.h)).toEqual([3000, 4800]);
    watch.stop();
  });

  it('sends the new page’s size a moment after a route change, even if it did not change', () => {
    vi.useFakeTimers();
    const sent: LayoutPayload[] = [];
    const watch = watchLayout((payload) => sent.push(payload));
    watch.force();
    vi.advanceTimersByTime(1);
    watch.navigated();
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS - 50);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
    watch.stop();
  });

  it('sends at most fifty per page, and nothing after stop', () => {
    vi.useFakeTimers();
    const sent: LayoutPayload[] = [];
    const watch = watchLayout((payload) => sent.push(payload));
    for (let i = 0; i < 80; i += 1) {
      watch.force();
      vi.advanceTimersByTime(1);
    }
    expect(sent).toHaveLength(50);
    watch.navigated();
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS + 1);
    expect(sent).toHaveLength(51);
    watch.stop();
    watch.force();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(51);
  });
});

describe('addClickOffset', () => {
  const click = (x: number, y: number, id = 7) => ({ type: 3, data: { source: 2, type: 2, id, x, y } as Record<string, unknown> });

  it('adds where in the element the click landed, in thousandths of its box', () => {
    const button = document.getElementById('buy')!;
    boxOf(button, { left: 100, top: 200, width: 200, height: 40 });
    const event = click(150, 230);
    addClickOffset(event, () => button);
    expect(event.data).toMatchObject({ ox: 250, oy: 750 });
  });

  it('keeps the offset inside the box, and sends nothing about the element itself', () => {
    const button = document.getElementById('buy')!;
    boxOf(button, { left: 100, top: 200, width: 200, height: 40 });
    const event = click(320, 190);
    addClickOffset(event, () => button);
    expect(event.data).toEqual({ source: 2, type: 2, id: 7, x: 320, y: 190, ox: 1000, oy: 0 });
  });

  it('leaves alone what is not a click, an element without a size, and a node it cannot measure', () => {
    const button = document.getElementById('buy')!;
    boxOf(button, { left: 0, top: 0, width: 0, height: 0 });
    const zero = click(1, 1);
    addClickOffset(zero, () => button);
    expect(zero.data.ox).toBeUndefined();

    const text = click(1, 1);
    addClickOffset(text, () => document.createTextNode('x'));
    expect(text.data.ox).toBeUndefined();

    const mousedown = { type: 3, data: { source: 2, type: 1, id: 7, x: 1, y: 1 } as Record<string, unknown> };
    addClickOffset(mousedown, () => button);
    expect(mousedown.data.ox).toBeUndefined();
  });
});

describe('the recorder', () => {
  interface Chunk { events: Array<{ type: number; timestamp: number; data: Record<string, unknown> }> }
  const handles: RecorderHandle[] = [];
  afterEach(() => { for (const handle of handles.splice(0)) handle.stop(); });

  it('sends the page’s size after the snapshot, and the offset on every click; the stream conforms', async () => {
    const calls: Chunk[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Chunk);
      return new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 });
    }));
    const handle = createRecorder({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    handles.push(handle);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const button = document.getElementById('buy')!;
    boxOf(button, { left: 10, top: 20, width: 100, height: 50 });
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 35, clientY: 45 }));
    await handle.flush();

    const events = calls.flatMap((chunk) => chunk.events);
    const snapshot = events.findIndex((e) => e.type === 2);
    const layout = events.findIndex((e) => e.type === 5 && e.data.tag === LAYOUT_TAG);
    expect(layout).toBeGreaterThan(snapshot);
    expect(events[layout]!.data.payload).toEqual({ w: window.innerWidth, h: 3000, vw: window.innerWidth, vh: window.innerHeight });
    const clicked = events.find((e) => e.type === 3 && e.data.source === 2 && e.data.type === 2);
    expect(clicked?.data).toMatchObject({ ox: 250, oy: 500 });
    expect(checkRecording(events, { family: 'web' }).filter((v) => v.severity === 'error')).toEqual([]);
  });
});
