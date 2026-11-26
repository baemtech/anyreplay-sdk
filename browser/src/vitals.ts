/**
 * Web vitals: how fast the page felt, beside the replay of how it was used.
 *
 * One `anyreplay.vitals` custom event per page load, carrying the five
 * numbers a performance review starts from:
 *
 * - **LCP** — when the largest thing on screen finished painting.
 * - **INP** — how long the slowest interaction took to answer (near the 98th
 *   percentile once there are many, as Chrome computes it).
 * - **CLS** — how much the layout jumped, in its worst one-to-five-second burst.
 * - **FCP** — when anything first painted.
 * - **TTFB** — when the first byte of the document arrived.
 *
 * Reported when the page is hidden (switching tab, closing it, navigating
 * away) and again on each later hide if a number grew, because INP and CLS
 * keep growing for as long as the page is used. Ingest keeps the worst value
 * per session, so a repeated report never counts twice. Single-page route
 * changes are not new page loads: LCP, FCP and TTFB belong to the hard load,
 * and INP and CLS keep accumulating across routes, as in Chrome's own report.
 *
 * Numbers only, plus the page's URL put through the same redaction as a
 * network entry. A browser without the entry types reports what it has, and
 * one without `PerformanceObserver` reports nothing. Nothing here throws.
 */

import { redactUrl } from './diagnostics.js';

/** Contract with `apps/ingest/src/custom-events.ts`. */
export const VITALS_TAG = 'anyreplay.vitals';

/** A page left open for a day hides many times; past this it has said everything. */
export const MAX_VITALS_REPORTS = 10;

export interface VitalsPayload {
  /** The page's URL, redacted. */
  url: string;
  /** Milliseconds, rounded. Absent when the browser did not say. */
  lcp?: number;
  inp?: number;
  fcp?: number;
  ttfb?: number;
  /** Unitless, to four decimals. */
  cls?: number;
}

export interface VitalsHandle {
  /** Sends what is known now, if anything changed since the last report. */
  report: () => void;
  /** Disconnects the observers and the listeners. Safe to call twice. */
  stop: () => void;
}

interface ShiftEntry extends PerformanceEntry { value: number; hadRecentInput: boolean }
interface InteractionEntry extends PerformanceEntry { interactionId?: number }

/** Gap and span of a CLS session window, per the metric's definition. */
const CLS_GAP_MS = 1000;
const CLS_SPAN_MS = 5000;

/**
 * INP from the slowest interaction of each id: the worst one, or for a page
 * with many interactions, one in fifty ignored as outliers.
 */
export function inpFrom(durations: readonly number[]): number | undefined {
  if (durations.length === 0) return undefined;
  const sorted = [...durations].sort((a, b) => b - a);
  const skip = Math.min(sorted.length - 1, Math.floor(sorted.length / 50));
  return sorted[skip];
}

/** The largest sum of layout shifts within one window, ignoring shifts right after input. */
export function clsFrom(entries: readonly { startTime: number; value: number; hadRecentInput?: boolean }[]): number {
  let worst = 0;
  let current = 0;
  let first = 0;
  let last = 0;
  for (const entry of entries) {
    if (entry.hadRecentInput) continue;
    if (current > 0 && entry.startTime - last < CLS_GAP_MS && entry.startTime - first < CLS_SPAN_MS) {
      current += entry.value;
    } else {
      current = entry.value;
      first = entry.startTime;
    }
    last = entry.startTime;
    if (current > worst) worst = current;
  }
  return worst;
}

const supports = (type: string): boolean => {
  try {
    return typeof PerformanceObserver !== 'undefined'
      && Array.isArray(PerformanceObserver.supportedEntryTypes)
      && PerformanceObserver.supportedEntryTypes.includes(type);
  } catch {
    return false;
  }
};

export function startVitals(emit: (tag: string, payload: VitalsPayload) => void): VitalsHandle {
  const observers: { observer: PerformanceObserver; handle: (entries: PerformanceEntry[]) => void }[] = [];
  const undo: (() => void)[] = [];
  let lcp: number | undefined;
  let fcp: number | undefined;
  let lcpFinal = false;
  const shifts: { startTime: number; value: number }[] = [];
  const interactions = new Map<number, number>();
  let reports = 0;
  let lastSent = '';
  let stopped = false;

  const observe = (type: string, onEntries: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}): void => {
    if (!supports(type)) return;
    try {
      const handle = (entries: PerformanceEntry[]): void => {
        try { onEntries(entries); } catch { /* never the page's problem */ }
      };
      const observer = new PerformanceObserver((list) => handle(list.getEntries()));
      observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push({ observer, handle });
    } catch { /* an older engine that lists the type but rejects the options */ }
  };

  observe('paint', (entries) => {
    for (const entry of entries) if (entry.name === 'first-contentful-paint') fcp = entry.startTime;
  });
  observe('largest-contentful-paint', (entries) => {
    if (lcpFinal) return;
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  });
  observe('layout-shift', (entries) => {
    for (const entry of entries as ShiftEntry[]) {
      if (!entry.hadRecentInput) shifts.push({ startTime: entry.startTime, value: entry.value });
    }
  });
  const noteInteraction = (entries: PerformanceEntry[]): void => {
    for (const entry of entries as InteractionEntry[]) {
      const id = entry.interactionId;
      if (!id) continue;
      interactions.set(id, Math.max(interactions.get(id) ?? 0, entry.duration));
    }
  };
  observe('event', noteInteraction, { durationThreshold: 40 });
  observe('first-input', noteInteraction);

  // LCP stops at the first input: what paints after the visitor acts is a
  // response to them, not the page loading.
  if (typeof window !== 'undefined') {
    const finalise = (): void => { lcpFinal = true; };
    for (const type of ['keydown', 'pointerdown'] as const) {
      window.addEventListener(type, finalise, { capture: true, once: true, passive: true });
      undo.push(() => window.removeEventListener(type, finalise, { capture: true }));
    }
  }

  const ttfb = (): number | undefined => {
    try {
      const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (!navigation || !(navigation.responseStart > 0)) return undefined;
      const activation = (navigation as PerformanceNavigationTiming & { activationStart?: number }).activationStart ?? 0;
      return Math.max(0, navigation.responseStart - activation);
    } catch {
      return undefined;
    }
  };

  const report = (): void => {
    if (stopped || reports >= MAX_VITALS_REPORTS) return;
    try {
      // Pending entries are delivered before the page goes; take them now.
      for (const { observer, handle } of observers) {
        const pending = observer.takeRecords?.() ?? [];
        if (pending.length) handle(pending);
      }
      lcpFinal = true;
      const payload: VitalsPayload = { url: redactUrl(typeof location !== 'undefined' ? location.href : '') };
      if (lcp !== undefined) payload.lcp = Math.round(lcp);
      const inp = inpFrom([...interactions.values()]);
      if (inp !== undefined) payload.inp = Math.round(inp);
      if (fcp !== undefined) payload.fcp = Math.round(fcp);
      const firstByte = ttfb();
      if (firstByte !== undefined) payload.ttfb = Math.round(firstByte);
      if (supports('layout-shift')) payload.cls = Math.round(clsFrom(shifts) * 10_000) / 10_000;
      const { url: _url, ...numbers } = payload;
      if (Object.keys(numbers).length === 0) return;
      const key = JSON.stringify(numbers);
      if (key === lastSent) return;
      lastSent = key;
      reports += 1;
      emit(VITALS_TAG, payload);
    } catch { /* never the page's problem */ }
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const onHidden = (): void => { if (document.visibilityState === 'hidden') report(); };
    document.addEventListener('visibilitychange', onHidden, { capture: true });
    window.addEventListener('pagehide', report, { capture: true });
    undo.push(() => {
      document.removeEventListener('visibilitychange', onHidden, { capture: true });
      window.removeEventListener('pagehide', report, { capture: true });
    });
  }

  return {
    report,
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const { observer } of observers) {
        try { observer.disconnect(); } catch { /* already gone */ }
      }
      for (const fn of undo) {
        try { fn(); } catch { /* as above */ }
      }
    },
  };
}
