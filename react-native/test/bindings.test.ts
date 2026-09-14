import { describe, expect, it, vi } from 'vitest';
import { touchCaptureProps } from '../src/gestures.js';
import { watchNavigation, type RouteReporter } from '../src/navigation.js';
import { watchAppState, type AppStateLike, type AppStateValue } from '../src/lifecycle.js';

describe('touch capture', () => {
  const fire = (props: Record<string, unknown>, event: unknown): boolean =>
    (props.onStartShouldSetResponderCapture as (e: unknown) => boolean)(event);

  it('reports the tap in screen coordinates', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));

    fire(props, { nativeEvent: { pageX: 120, pageY: 300, locationX: 5, locationY: 5 } });
    // pageX, not locationX: the recording is in screen coordinates, and
    // locationX is relative to whatever view happened to be hit.
    expect(taps).toEqual([[120, 300]]);
  });

  /**
   * The contract that makes this observation rather than interception. If any
   * of these ever returned true the recorder would swallow the gesture and the
   * button underneath would stop working — a recorder that changes how the app
   * behaves is worse than no recorder.
   */
  it('never claims the gesture, so the app still receives it', () => {
    const props = touchCaptureProps(() => {});
    const event = { nativeEvent: { pageX: 1, pageY: 1 } };

    expect((props.onStartShouldSetResponderCapture as (e: unknown) => boolean)(event)).toBe(false);
    expect((props.onMoveShouldSetResponderCapture as (e: unknown) => boolean)(event)).toBe(false);
  });

  it('still declines the gesture when the sink throws', () => {
    const props = touchCaptureProps(() => { throw new Error('recorder exploded'); });
    expect(() => fire(props, { nativeEvent: { pageX: 1, pageY: 1 } })).not.toThrow();
    expect(fire(props, { nativeEvent: { pageX: 1, pageY: 1 } })).toBe(false);
  });

  it('ignores an event with no coordinates rather than recording a tap at the origin', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));
    fire(props, { nativeEvent: {} });
    fire(props, {});
    expect(taps).toEqual([]);
  });
});

describe('navigation', () => {
  function fakeContainer(initial: string) {
    let route = initial;
    let handler: (() => void) | null = null;
    const container: RouteReporter = {
      getCurrentRoute: () => ({ name: route }),
      addListener: (_event, fn) => { handler = fn; return () => { handler = null; }; },
    };
    return {
      container,
      navigate: (name: string) => { route = name; handler?.(); },
      emitWithoutNavigating: () => handler?.(),
      listening: () => handler !== null,
    };
  }

  it('reports the screen the app starts on', () => {
    const screens: string[] = [];
    const nav = fakeContainer('Home');
    watchNavigation(nav.container, (name) => screens.push(name));
    expect(screens).toEqual(['Home']);
  });

  it('reports each new screen', () => {
    const screens: string[] = [];
    const nav = fakeContainer('Home');
    watchNavigation(nav.container, (name) => screens.push(name));
    nav.navigate('Settings');
    nav.navigate('Profile');
    expect(screens).toEqual(['Home', 'Settings', 'Profile']);
  });

  /**
   * A navigator emits state changes for reasons that are not navigations — a
   * keyboard opening, a param changing — and each one would otherwise cost a
   * full snapshot of a screen that did not change.
   */
  it('says nothing when the state changes but the screen does not', () => {
    const screens: string[] = [];
    const nav = fakeContainer('Home');
    watchNavigation(nav.container, (name) => screens.push(name));
    nav.emitWithoutNavigating();
    nav.emitWithoutNavigating();
    expect(screens).toEqual(['Home']);
  });

  it('stops listening when told to', () => {
    const nav = fakeContainer('Home');
    const stop = watchNavigation(nav.container, () => {});
    expect(nav.listening()).toBe(true);
    stop();
    expect(nav.listening()).toBe(false);
  });

  it('survives a navigator that throws mid-transition', () => {
    const container: RouteReporter = {
      getCurrentRoute: () => { throw new Error('transitioning'); },
      addListener: () => () => {},
    };
    expect(() => watchNavigation(container, () => {})).not.toThrow();
  });
});

describe('app lifecycle', () => {
  function fakeAppState() {
    let handler: ((state: AppStateValue) => void) | null = null;
    const appState: AppStateLike = {
      addEventListener: (_type, fn) => { handler = fn; return { remove: () => { handler = null; } }; },
    };
    return { appState, send: (state: AppStateValue) => handler?.(state), attached: () => handler !== null };
  }

  /**
   * The only chance to send the tail of a session. After the app is killed
   * there is nowhere left to run, so the flush has to happen at the last
   * moment the thread is still alive.
   */
  it('flushes when the app goes to the background', () => {
    const flush = vi.fn();
    const app = fakeAppState();
    watchAppState(app.appState, { onLeaving: flush });

    app.send('background');
    expect(flush).toHaveBeenCalledTimes(1);
  });

  /**
   * `inactive` is the iOS state for a transition — the app switcher, an
   * incoming call. Flushing on it would send a chunk every time someone
   * glanced at the notification shade.
   */
  it('does not flush merely because the app went inactive', () => {
    const flush = vi.fn();
    const app = fakeAppState();
    watchAppState(app.appState, { onLeaving: flush });

    app.send('inactive');
    expect(flush).not.toHaveBeenCalled();
  });

  it('reports how long the app was away when it returns', () => {
    const away: number[] = [];
    const app = fakeAppState();
    watchAppState(app.appState, { onLeaving: () => {}, onReturning: (ms) => away.push(ms) });

    app.send('background');
    app.send('active');
    expect(away).toHaveLength(1);
    expect(away[0]).toBeGreaterThanOrEqual(0);
  });

  it('says nothing about returning if it never left', () => {
    const onReturning = vi.fn();
    const app = fakeAppState();
    watchAppState(app.appState, { onLeaving: () => {}, onReturning });
    app.send('active');
    expect(onReturning).not.toHaveBeenCalled();
  });

  it('never lets a failing flush reach the app', () => {
    const app = fakeAppState();
    watchAppState(app.appState, { onLeaving: () => { throw new Error('offline'); } });
    expect(() => app.send('background')).not.toThrow();
  });

  it('detaches when told to', () => {
    const app = fakeAppState();
    const stop = watchAppState(app.appState, { onLeaving: () => {} });
    expect(app.attached()).toBe(true);
    stop();
    expect(app.attached()).toBe(false);
  });
});
