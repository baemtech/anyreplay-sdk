/**
 * What heatmaps need from the page that rrweb does not record (contract §4.2).
 *
 * Two things, both small and both free of anything the visitor wrote:
 *
 *  - the page's size, as an `anyreplay.layout` custom event, so that "how far
 *    down did people get" can be a share of the page rather than a guess;
 *  - where inside its element a click landed, as `ox`/`oy` on rrweb's own
 *    click event, so heat can be drawn on the element exactly even when the
 *    element sits elsewhere in another visit's layout.
 */

export const LAYOUT_TAG = 'anyreplay.layout';

export interface LayoutPayload {
  /** Document width and height, CSS pixels. */
  w: number;
  h: number;
  /** Viewport width and height, CSS pixels. */
  vw: number;
  vh: number;
}

/** A height change smaller than both of these is noise: a 5% step is the scroll map's resolution. */
const MIN_HEIGHT_CHANGE_PX = 64;
const MIN_HEIGHT_CHANGE_SHARE = 0.05;
/** Settling time for each kind of trigger. */
const RESIZE_DEBOUNCE_MS = 400;
const MUTATION_DEBOUNCE_MS = 600;
const SCROLL_DEBOUNCE_MS = 1000;
/** After a route change: the new page has usually rendered by then. */
export const NAVIGATION_DELAY_MS = 400;
/** Without a ResizeObserver, how often the height is looked at. */
const POLL_MS = 2000;
/** A page whose height never settles (an animation, a ticker) does not get to fill the recording. */
const MAX_PER_PAGE = 50;

/** The page's size now, or null where there is no document to measure. */
export function measureLayout(): LayoutPayload | null {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    const root = document.documentElement;
    const body = document.body;
    if (!root) return null;
    const vw = Math.round(window.innerWidth || root.clientWidth || 0);
    const vh = Math.round(window.innerHeight || root.clientHeight || 0);
    // The larger of the two: a page that scrolls its <body> rather than the
    // window has an <html> exactly as tall as the screen.
    const h = Math.round(Math.max(root.scrollHeight || 0, body?.scrollHeight ?? 0, vh));
    const w = Math.round(Math.max(root.scrollWidth || 0, body?.scrollWidth ?? 0, vw));
    if (vw <= 0 || vh <= 0 || h <= 0 || w <= 0) return null;
    return { w, h, vw, vh };
  } catch {
    return null;
  }
}

/** Whether `next` says something `last` did not: a new viewport, or a height that moved enough to matter. */
export function layoutChanged(last: LayoutPayload | null, next: LayoutPayload): boolean {
  if (!last) return true;
  if (last.vw !== next.vw || last.vh !== next.vh || last.w !== next.w) return true;
  const delta = Math.abs(next.h - last.h);
  return delta >= MIN_HEIGHT_CHANGE_PX && delta >= last.h * MIN_HEIGHT_CHANGE_SHARE;
}

export interface LayoutWatch {
  /** Send the size on the next turn whatever it is: a new snapshot or a new page wants its own. */
  force: (delayMs?: number) => void;
  /** A route change: the per-page budget starts again, and the new page's size goes out shortly. */
  navigated: () => void;
  stop: () => void;
}

/**
 * Watches the page's size and emits it when it matters.
 *
 * Everything is debounced and read in a timer, never inside the page's own
 * resize or scroll handlers, and `scrollHeight` is read at most once per
 * settled change — it can force a layout, and a recorder must not make the
 * page slower to scroll.
 */
export function watchLayout(emit: (payload: LayoutPayload) => void): LayoutWatch {
  let last: LayoutPayload | null = null;
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  let stopped = false;

  const check = (): void => {
    timer = undefined;
    if (stopped) return;
    const next = measureLayout();
    const force = forced;
    forced = false;
    if (!next || (!force && !layoutChanged(last, next))) return;
    if (sent >= MAX_PER_PAGE) return;
    last = next;
    sent += 1;
    emit(next);
  };

  /** Runs `check` once things settle; a forced check is never pushed back by a later, lazier one. */
  const schedule = (delayMs: number, force = false): void => {
    if (stopped) return;
    if (force) forced = true;
    if (timer !== undefined) {
      if (!force) return;
      clearTimeout(timer);
    }
    timer = setTimeout(check, delayMs);
  };

  const cleanups: Array<() => void> = [];
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onResize = (): void => schedule(RESIZE_DEBOUNCE_MS);
    const onScroll = (): void => schedule(SCROLL_DEBOUNCE_MS);
    window.addEventListener('resize', onResize, { passive: true });
    // Capture: a page that scrolls its <body> fires scroll on the body, not the window.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    cleanups.push(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, { capture: true });
    });
  }
  if (typeof ResizeObserver === 'function' && typeof document !== 'undefined') {
    try {
      const observer = new ResizeObserver(() => schedule(MUTATION_DEBOUNCE_MS));
      if (document.documentElement) observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
      cleanups.push(() => observer.disconnect());
    } catch {
      /* no observer: the scroll and resize checks still run */
    }
  } else {
    const poll = setInterval(() => schedule(0), POLL_MS);
    cleanups.push(() => clearInterval(poll));
  }

  return {
    force: (delayMs = 0) => schedule(delayMs, true),
    navigated: () => {
      sent = 0;
      schedule(NAVIGATION_DELAY_MS, true);
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const cleanup of cleanups) cleanup();
    },
  };
}

/** rrweb's IncrementalSnapshot, MouseInteraction and the Click interaction. */
const INCREMENTAL = 3;
const MOUSE_INTERACTION = 2;
const CLICK = 2;

/**
 * Adds `ox`/`oy` to an rrweb click: where in the target element's box it
 * landed, in thousandths. Called from the recorder's `emit`, which rrweb calls
 * from inside its own click listener (capture phase, before the page's
 * handlers), so the box is the one the person clicked on.
 */
export function addClickOffset(
  event: { type: number; data?: unknown },
  nodeOf: (id: number) => unknown,
): void {
  if (event.type !== INCREMENTAL) return;
  const data = event.data as { source?: unknown; type?: unknown; id?: unknown; x?: unknown; y?: unknown; ox?: unknown; oy?: unknown } | undefined;
  if (!data || data.source !== MOUSE_INTERACTION || data.type !== CLICK) return;
  if (typeof data.id !== 'number' || typeof data.x !== 'number' || typeof data.y !== 'number') return;
  try {
    const node = nodeOf(data.id) as { getBoundingClientRect?: () => DOMRect; ownerDocument?: Document | null } | null;
    if (!node || typeof node.getBoundingClientRect !== 'function') return;
    // An element inside a same-origin iframe reports its box in that frame's
    // coordinates, and the click's x/y are the frame's too — but heatmaps
    // place clicks on the page, which that frame is not.
    if (typeof document !== 'undefined' && node.ownerDocument && node.ownerDocument !== document) return;
    const box = node.getBoundingClientRect();
    if (!(box.width >= 1) || !(box.height >= 1)) return;
    data.ox = thousandths((data.x - box.left) / box.width);
    data.oy = thousandths((data.y - box.top) / box.height);
  } catch {
    /* the offset is a nicety; the click is recorded without it */
  }
}

function thousandths(share: number): number {
  if (!Number.isFinite(share)) return 500;
  return Math.min(1000, Math.max(0, Math.round(share * 1000)));
}
