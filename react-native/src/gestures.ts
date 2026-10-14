/**
 * Capturing taps without asking the app to help.
 *
 * React Native has no document to listen on, so there is no equivalent of the
 * web recorder's single global click listener. What it does have is touch
 * events that travel through React's tree like DOM events do — a capture
 * phase from the root down, then a bubble phase back up — and every `View`
 * can listen to them: `onTouchStartCapture`, `onTouchMoveCapture`,
 * `onTouchEndCapture`, `onTouchCancelCapture`.
 *
 * Those are listeners, not the gesture responder system. A view that listens
 * takes no part in deciding who handles the touch: it claims nothing, it
 * returns nothing, and it cannot stop the touch reaching the button
 * underneath or the scroll view from scrolling. Listening in the *capture*
 * phase, at a view wrapped around the whole app, means it hears every touch
 * before any child does — so no child can stop propagation before it is heard.
 *
 * The first release used `onStartShouldSetResponderCapture` and
 * `onMoveShouldSetResponderCapture` returning false instead. That observes
 * without intercepting too, but it is only ever told about a touch starting
 * and moving — never about it ending — so it reported a tap on touch start and
 * again on every move, and a scroll became a run of taps (and, quick enough, a
 * rage tap). The responder system has no "released" question to ask a view
 * that declined, so the release can only be heard this way.
 *
 * A tap is reported once, when the finger lifts, and only if it never moved
 * more than the touch slop from where it went down — the same distinction the
 * platform draws between a tap and a drag. A touch the system cancels (a
 * scroll view taking over, an alert appearing) is never a tap.
 */

export interface TouchPoint {
  identifier?: number;
  pageX?: number;
  pageY?: number;
}

export interface TouchLike {
  nativeEvent?: TouchPoint & { changedTouches?: TouchPoint[]; locationX?: number; locationY?: number };
}

export type TouchSink = (x: number, y: number) => void;

/**
 * How far a finger may wander and still be tapping, in points.
 *
 * Android's `ViewConfiguration.getScaledTouchSlop()` is 8 dp on stock builds
 * and some manufacturers raise it; UIKit's tap recogniser allows about 10 pt.
 * Neither is readable from JavaScript without a native module, so both
 * platforms use the larger: a tap that wobbles 9 pt on Android is still a tap
 * to the person who made it, and a scroll travels much further than 10 pt.
 */
export const TOUCH_SLOP_PT = 10;

interface Down { x: number; y: number; moved: boolean }

/**
 * The props to spread onto a view wrapping the whole app.
 *
 * Each handler only listens, and none can throw into the app's gesture: the
 * sink is guarded, and a malformed event is ignored rather than recorded at
 * the origin.
 *
 * A tap is reported at the position the finger went *down*. That is where
 * React Native hit-tests a touch to decide which control receives it, so it is
 * the point a reader hit-testing the recording should use; within the slop
 * the two positions differ by at most 10 points anyway. It is reported when
 * the finger lifts, which is when the control acts.
 */
export function touchCaptureProps(onTouch: TouchSink, slop = TOUCH_SLOP_PT): Record<string, unknown> {
  const down = new Map<number, Down>();

  /** The touches this event is about, with `pageX`/`pageY` in screen points. */
  const changed = (event: TouchLike): TouchPoint[] => {
    const native = event?.nativeEvent;
    if (!native) return [];
    // `changedTouches` names every finger the event is about; without it the
    // event itself is the one touch. `pageX` is relative to the screen, which
    // is the coordinate space the recording is in — `locationX` is relative to
    // whatever view happened to be hit and would put the tap in the wrong place.
    return Array.isArray(native.changedTouches) && native.changedTouches.length > 0 ? native.changedTouches : [native];
  };
  const idOf = (touch: TouchPoint): number => (typeof touch.identifier === 'number' ? touch.identifier : 0);
  const point = (touch: TouchPoint): { x: number; y: number } | null =>
    typeof touch.pageX === 'number' && typeof touch.pageY === 'number'
      && Number.isFinite(touch.pageX) && Number.isFinite(touch.pageY)
      ? { x: touch.pageX, y: touch.pageY } : null;
  const far = (from: Down, to: { x: number; y: number }): boolean =>
    Math.hypot(to.x - from.x, to.y - from.y) > slop;

  const listen = (handle: (touch: TouchPoint) => void) => (event: TouchLike): void => {
    try {
      for (const touch of changed(event)) handle(touch);
    } catch { /* a recorder must never break a gesture */ }
  };

  return {
    onTouchStartCapture: listen((touch) => {
      const at = point(touch);
      if (at) down.set(idOf(touch), { ...at, moved: false });
    }),
    onTouchMoveCapture: listen((touch) => {
      const start = down.get(idOf(touch));
      const at = point(touch);
      // Once past the slop it stays a drag, even if it comes back to where it
      // started: that is a swipe there and back, not a tap.
      if (start && at && !start.moved && far(start, at)) start.moved = true;
    }),
    onTouchEndCapture: listen((touch) => {
      const id = idOf(touch);
      const start = down.get(id);
      down.delete(id);
      if (!start || start.moved) return;
      const at = point(touch);
      // A move event can be skipped under load; the lifting point is checked too.
      if (at && far(start, at)) return;
      try { onTouch(start.x, start.y); } catch { /* a recorder must never break a gesture */ }
    }),
    onTouchCancelCapture: listen((touch) => { down.delete(idOf(touch)); }),
    collapsable: false,
  };
}
