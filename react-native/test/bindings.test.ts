import { describe, expect, it, vi } from 'vitest';
import { touchCaptureProps } from '../src/gestures.js';
import { watchNavigation, type RouteReporter } from '../src/navigation.js';
import { watchAppState, type AppStateLike, type AppStateValue } from '../src/lifecycle.js';

describe('touch capture', () => {
  type Handler = (event: unknown) => unknown;
  const touch = (pageX: number, pageY: number, identifier = 0) => ({ nativeEvent: { identifier, pageX, pageY } });
  /** One finger down, along a path, and up: what React Native sends the root view's capture listeners. */
  const gesture = (props: Record<string, unknown>, path: [number, number][], id = 0, end: 'end' | 'cancel' = 'end') => {
    const [first, ...rest] = path;
    (props.onTouchStartCapture as Handler)(touch(first![0], first![1], id));
    for (const [x, y] of rest) (props.onTouchMoveCapture as Handler)(touch(x, y, id));
    const [lx, ly] = path[path.length - 1]!;
    (props[end === 'end' ? 'onTouchEndCapture' : 'onTouchCancelCapture'] as Handler)(touch(lx, ly, id));
  };

  it('reports a tap once, when the finger lifts, in screen coordinates', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));

    (props.onTouchStartCapture as Handler)({ nativeEvent: { identifier: 0, pageX: 120, pageY: 300, locationX: 5, locationY: 5 } });
    // Nothing yet: a touch going down is not a tap until it comes up again.
    expect(taps).toEqual([]);
    (props.onTouchEndCapture as Handler)({ nativeEvent: { identifier: 0, pageX: 121, pageY: 301, locationX: 6, locationY: 6 } });
    // pageX, not locationX: the recording is in screen coordinates, and
    // locationX is relative to whatever view happened to be hit. Where the
    // finger went down, which is where React Native hit-tested the touch.
    expect(taps).toEqual([[120, 300]]);
  });

  it('calls a wobble inside the touch slop a tap', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));
    gesture(props, [[100, 100], [104, 103], [106, 106]]);
    expect(taps).toEqual([[100, 100]]);
  });

  /**
   * The first release reported a "tap" on touch start and on every move, so a
   * scroll became a run of taps a few points apart — and, quick enough, a
   * rage tap on a screen nobody was angry at.
   */
  it('never reports a scroll, a swipe or a drag', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));
    gesture(props, [[200, 600], [200, 560], [200, 480], [200, 300]]);   // a scroll
    gesture(props, [[50, 400], [150, 405], [300, 410]]);                // a swipe
    gesture(props, [[100, 100], [130, 100], [100, 100]]);               // there and back again
    expect(taps).toEqual([]);
  });

  it('checks where the finger lifted, in case a move event never arrived', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));
    (props.onTouchStartCapture as Handler)(touch(100, 100));
    (props.onTouchEndCapture as Handler)(touch(100, 180));
    expect(taps).toEqual([]);
  });

  it('drops a touch the system cancelled, such as one a scroll view took over', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));
    gesture(props, [[100, 100], [101, 101]], 0, 'cancel');
    expect(taps).toEqual([]);
  });

  it('follows each finger on its own', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));
    (props.onTouchStartCapture as Handler)(touch(50, 50, 1));
    (props.onTouchStartCapture as Handler)(touch(300, 300, 2));
    // The second finger drags; the first stays put.
    (props.onTouchMoveCapture as Handler)({ nativeEvent: { changedTouches: [{ identifier: 2, pageX: 300, pageY: 400 }] } });
    (props.onTouchEndCapture as Handler)({ nativeEvent: { changedTouches: [{ identifier: 2, pageX: 300, pageY: 400 }] } });
    (props.onTouchEndCapture as Handler)({ nativeEvent: { changedTouches: [{ identifier: 1, pageX: 50, pageY: 51 }] } });
    expect(taps).toEqual([[50, 50]]);
  });

  /**
   * The contract that makes this observation rather than interception. The
   * view takes no part in the responder system — it never asks for the
   * gesture, so it can never be given it — and its listeners return nothing
   * an event system could read as "handled".
   */
  it('never asks for the gesture, so the app still receives it', () => {
    const props = touchCaptureProps(() => {});
    expect(props).not.toHaveProperty('onStartShouldSetResponderCapture');
    expect(props).not.toHaveProperty('onMoveShouldSetResponderCapture');
    expect(props).not.toHaveProperty('onStartShouldSetResponder');
    expect(props).not.toHaveProperty('onResponderGrant');
    for (const name of ['onTouchStartCapture', 'onTouchMoveCapture', 'onTouchEndCapture', 'onTouchCancelCapture']) {
      expect((props[name] as Handler)(touch(1, 1))).toBeUndefined();
    }
  });

  it('never lets a throwing sink reach the gesture', () => {
    const props = touchCaptureProps(() => { throw new Error('recorder exploded'); });
    expect(() => gesture(props, [[1, 1]])).not.toThrow();
  });

  it('ignores an event with no coordinates rather than recording a tap at the origin', () => {
    const taps: [number, number][] = [];
    const props = touchCaptureProps((x, y) => taps.push([x, y]));
    for (const event of [{ nativeEvent: {} }, {}, null]) {
      (props.onTouchStartCapture as Handler)(event);
      (props.onTouchEndCapture as Handler)(event);
    }
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
