/**
 * Capturing taps without asking the app to help.
 *
 * React Native has no document to listen on, so there is no equivalent of the
 * web recorder's single global click listener. What it does have is a gesture
 * responder system with a documented escape hatch: a view may ask to be offered
 * every touch *before* its children see it, and may then decline to handle it.
 * A view like that, wrapped around the app, sees every tap and swallows none.
 *
 * `onStartShouldSetResponderCapture` returning false is the whole trick. It is
 * called on the way down, so the touch is observed at the outermost view, and
 * returning false hands the gesture straight back — the button underneath
 * still gets pressed, the scroll view still scrolls, and nothing in the app
 * behaves differently because a recorder is running.
 *
 * The alternative, patching the responder system or requiring the app to route
 * its own touches, would be both more fragile and visible to the app. A
 * recorder must be neither.
 */

export interface TouchLike {
  nativeEvent?: { pageX?: number; pageY?: number; locationX?: number; locationY?: number };
}

export type TouchSink = (x: number, y: number) => void;

/**
 * The props to spread onto a view wrapping the whole app.
 *
 * Every handler returns false. That is not an oversight — it is the contract
 * that makes this observation rather than interception.
 */
export function touchCaptureProps(onTouch: TouchSink): Record<string, unknown> {
  const observe = (event: TouchLike): boolean => {
    const native = event?.nativeEvent;
    // `pageX` is relative to the screen, which is the coordinate space the
    // recording is in. `locationX` is relative to whatever view happened to be
    // hit and would put the tap in the wrong place.
    const x = native?.pageX;
    const y = native?.pageY;
    if (typeof x === 'number' && typeof y === 'number') {
      try { onTouch(x, y); } catch { /* a recorder must never break a gesture */ }
    }
    // Declining the responder role is what lets the touch continue to the
    // control the person actually meant to press.
    return false;
  };

  return {
    onStartShouldSetResponderCapture: observe,
    // Movement is captured too, so a swipe is not silently a tap at its origin.
    onMoveShouldSetResponderCapture: observe,
    collapsable: false,
  };
}
