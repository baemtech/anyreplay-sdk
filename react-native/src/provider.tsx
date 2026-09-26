import * as React from 'react';
import { registerRoot, touchProps } from './native.js';

/**
 * The one thing an app has to add.
 *
 * ```tsx
 * <AnyReplay>
 *   <App />
 * </AnyReplay>
 * ```
 *
 * It does two things. It gives the recorder a way into React's tree — the
 * view's ref leads to the committed fiber root, which is walked on each tick —
 * and it is offered every touch, because React Native has no document to
 * listen on.
 *
 * The view it renders declines every gesture it is offered. The touch is seen
 * on the way down and handed straight back, so the button underneath is still
 * pressed and the scroll view still scrolls. An app behaves identically with
 * this wrapper and without it.
 */
export function AnyReplay({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Required at render time rather than imported at module load, so the package
  // still loads in a plain Node process for tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { View } = require('react-native') as { View: React.ComponentType<Record<string, unknown>> };

  const props = React.useMemo(() => touchProps(), []);
  // The ref is how the recorder finds React's tree: from this view it climbs to
  // the root and reads everything committed below it.
  return <View ref={registerRoot} style={{ flex: 1 }} {...props}>{children}</View>;
}
