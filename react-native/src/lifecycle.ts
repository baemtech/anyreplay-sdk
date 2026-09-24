/**
 * Not losing the end of a session.
 *
 * A browser gets `pagehide` and `sendBeacon`; a phone gets neither. What it
 * gets is a warning that the app is about to stop running — and after that
 * warning the JavaScript thread may simply be frozen mid-flush, on iOS often
 * within a second or two.
 *
 * So the tail is flushed when the app goes to the background rather than when
 * it is killed, because when it is killed there is no longer anywhere to run.
 * Everything after that point is lost either way; the difference is whether the
 * last thirty seconds of the session are lost with it.
 */

export type AppStateValue = 'active' | 'background' | 'inactive' | string;

export interface AppStateLike {
  addEventListener: (
    type: 'change',
    handler: (state: AppStateValue) => void,
  ) => { remove: () => void } | undefined;
}

export interface LifecycleHooks {
  /** Called when the app leaves the foreground. Should flush. */
  onLeaving: () => void;
  /** Called when it comes back, so a long absence can start a new session. */
  onReturning?: (awayMs: number) => void;
}

export function watchAppState(appState: AppStateLike, hooks: LifecycleHooks): () => void {
  let leftAt: number | null = null;

  const subscription = appState.addEventListener('change', (next) => {
    // `inactive` is the iOS state for a transition — the app switcher, an
    // incoming call — and treating it as leaving would flush on every glance
    // at the notification shade. `background` is the one that means gone.
    if (next === 'background') {
      leftAt = Date.now();
      try { hooks.onLeaving(); } catch { /* never surface to the app */ }
      return;
    }

    if (next === 'active' && leftAt !== null) {
      const awayMs = Date.now() - leftAt;
      leftAt = null;
      try { hooks.onReturning?.(awayMs); } catch { /* never surface to the app */ }
    }
  });

  return () => { try { subscription?.remove(); } catch { /* already gone */ } };
}
