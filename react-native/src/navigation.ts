/**
 * Following a person from screen to screen.
 *
 * A screen change is this platform's page view: it resets the recording's
 * snapshot, it increments the page count the dashboard shows, and it is the
 * label a reviewer scans a session by. Getting it automatically matters more
 * here than on the web, because a React Native app has no URL to fall back on
 * — miss the navigation and every session is one long unnamed screen.
 *
 * Written against the shape of react-navigation's container ref rather than
 * against the library, so it needs no dependency on it and works with any
 * navigator that can report a current route name.
 */

export interface RouteReporter {
  /** react-navigation's `getCurrentRoute`. */
  getCurrentRoute?: () => { name?: string } | undefined;
  /** react-navigation's `addListener('state', …)`, which returns an unsubscribe. */
  addListener?: (event: string, handler: () => void) => (() => void) | undefined;
}

export type ScreenSink = (name: string) => void;

/**
 * Watches a navigation container and reports each screen it settles on.
 *
 * Returns the unsubscribe. Duplicate names in a row are dropped: a navigator
 * emits state changes for reasons that are not navigations — a keyboard
 * opening, a param changing — and each one would otherwise cost a full
 * snapshot for a screen that did not change.
 */
export function watchNavigation(container: RouteReporter, onScreen: ScreenSink): () => void {
  let last: string | null = null;

  const report = (): void => {
    try {
      const name = container.getCurrentRoute?.()?.name;
      if (!name || name === last) return;
      last = name;
      onScreen(name);
    } catch {
      // A navigator mid-transition can throw. A recorder must not.
    }
  };

  report();
  const unsubscribe = container.addListener?.('state', report);
  return () => { try { unsubscribe?.(); } catch { /* already gone */ } };
}
