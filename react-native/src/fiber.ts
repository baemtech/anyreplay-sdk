import { isBundledAsset } from './assets.js';
import { fieldValue, isSensitiveField, looksLikeCardNumber } from './masking.js';
import { OPAQUE_TAGS, tagFor, type CapturedElement, type Rect } from './tree.js';
import type { MobileTag } from './wire.js';

/**
 * Reading the screen from React's committed tree.
 *
 * React Native has no DOM, but React keeps one of its own: the fiber tree it
 * last committed. Every host component in it — the `RCTView`s and `RCTText`s
 * that actually became native views — is a fiber with its props, its children
 * and a handle to the native node. Walking that tree on each tick gives the
 * recorder everything a DOM walk gives the web recorder: the real hierarchy,
 * exactly what is mounted right now, and the text inside it.
 *
 * The obvious alternative, wrapping `jsx()` / `createElement` to see elements
 * as they are made, looks equivalent and is not. Element creation is not
 * mounting — memoised subtrees are never re-created, so they vanish from a
 * registry rebuilt per render — and libraries that wrap the JSX runtime at load
 * (nativewind does) hold the original function, so a later patch sees nothing.
 * A committed tree has neither problem, and it needs nothing from the app's
 * Babel configuration.
 *
 * The fields read here — `tag`, `type`, `memoizedProps`, `stateNode`, `child`,
 * `sibling`, `return`, `alternate` — are the ones React DevTools reads, and
 * have kept their meaning across every React version React Native has shipped.
 */

export interface Fiber {
  tag: number;
  type: unknown;
  memoizedProps: unknown;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
}

/** React's work tags. Numerically stable since React 16. */
const HOST_ROOT = 3;
const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const OFFSCREEN = 22;

/** Where a host fiber is on screen, in window points, or null if unknown. */
export type Measure = (fiber: Fiber) => Rect | null;

export interface CaptureOptions {
  measure: Measure;
  screen: { width: number; height: number };
  /** Mask every `TextInput`, on top of the floor in `masking.ts`. */
  maskAllInputs: boolean;
  /** The same, and not weakened by `maskAllInputs: false`. */
  maskAllTyping?: boolean;
  maskTestID: string;
  /** Record no image URLs; every image replays masked. */
  maskImages?: boolean;
  /** The content hash of an app-bundled image, once it is known. Never waits. */
  assetFor?: (uri: string) => string | undefined;
}

/** The id of the synthetic element everything on screen hangs from. */
export const ROOT_ELEMENT_ID = 2;

/**
 * The committed root of the tree a fiber belongs to.
 *
 * A fiber reached through a view's public instance may be either of React's
 * two copies, and the one it is need not be the one on screen. Every copy's
 * ancestor chain ends at a HostRoot fiber whose `stateNode` is the FiberRoot,
 * and `FiberRoot.current` is by definition the committed tree — so the walk
 * always reads what is on screen, whichever copy it started from.
 */
export function currentRootOf(fiber: Fiber | null | undefined): Fiber | null {
  let node = fiber ?? null;
  for (let guard = 0; node && node.tag !== HOST_ROOT && guard < 100_000; guard += 1) {
    node = node.return;
  }
  if (!node || node.tag !== HOST_ROOT) return null;
  return (node.stateNode as { current?: Fiber } | null)?.current ?? node;
}

/**
 * Stable ids for host fibers.
 *
 * React keeps two copies of every fiber and swaps them on each commit, so an id
 * keyed on one copy is recorded on the other as well. A view keeps its id for as
 * long as it stays mounted, which is what lets a tick send a diff rather than a
 * new tree. Ids are even: a text node takes its element's id plus one.
 */
export class FiberIds {
  private readonly ids = new WeakMap<object, number>();
  private next = ROOT_ELEMENT_ID + 2;

  idFor(fiber: Fiber): number {
    let id = this.ids.get(fiber);
    if (id === undefined && fiber.alternate) id = this.ids.get(fiber.alternate);
    if (id === undefined) {
      id = this.next;
      this.next += 2;
    }
    this.ids.set(fiber, id);
    if (fiber.alternate) this.ids.set(fiber.alternate, id);
    return id;
  }
}

type Props = Record<string, unknown>;

function flattenStyle(style: unknown, into: Props = {}, depth = 0): Props {
  if (!style || depth > 32) return into;
  if (Array.isArray(style)) {
    for (const entry of style) flattenStyle(entry, into, depth + 1);
  } else if (typeof style === 'object') {
    Object.assign(into, style);
  }
  return into;
}

const TRANSPARENT = new Set(['transparent', 'rgba(0,0,0,0)', 'rgba(0, 0, 0, 0)', '#0000', '#00000000']);

function colour(value: unknown): string | undefined {
  // PlatformColor and DynamicColorIOS arrive as objects; there is no portable
  // way to resolve them from JavaScript, so they are left out rather than guessed.
  return typeof value === 'string' && !TRANSPARENT.has(value.replace(/\s+/g, ' ').trim()) ? value : undefined;
}

/** The role as the app wrote it: `role` wins over `accessibilityRole`, as it does in React Native. */
function rawRole(props: Props): string | undefined {
  const role = props.role ?? props.accessibilityRole;
  return typeof role === 'string' ? role : undefined;
}

/**
 * React Native's roles, narrowed to the format's (MOBILE-REPLAY-FORMAT §5).
 * `role` takes ARIA's words and `accessibilityRole` React Native's older
 * ones; both are read. A role outside the list is dropped, not guessed at.
 */
const ROLES: Record<string, string> = {
  button: 'button', imagebutton: 'button', togglebutton: 'button',
  link: 'link', header: 'header', heading: 'header', tab: 'tab',
  image: 'image', img: 'image', radio: 'radio', alert: 'alert', search: 'search', searchbox: 'search',
};

function hostTag(type: string, props: Props): MobileTag {
  const base = tagFor(type);
  if (base !== 'View' && base !== 'Unknown') return base;
  // Pressable and the Touchables render a plain view. What makes one a button
  // is what it answers to, and accessibility role is the most direct statement
  // of that when the app gives one.
  const role = rawRole(props);
  if (role === 'button' || role === 'imagebutton' || role === 'togglebutton') return 'Pressable';
  if (props.accessible === true
    && (typeof props.onClick === 'function' || typeof props.onResponderRelease === 'function')) {
    return 'Pressable';
  }
  return base;
}

/** `accessibilityState`, with the `aria-*` props React Native folds into it. */
function a11yState(props: Props): Props {
  const state = (props.accessibilityState && typeof props.accessibilityState === 'object'
    ? props.accessibilityState : {}) as Props;
  return {
    disabled: props['aria-disabled'] ?? state.disabled,
    checked: props['aria-checked'] ?? state.checked,
    selected: props['aria-selected'] ?? state.selected,
  };
}

/** A checkbox, switch or tab state, in the format's `on` values; undefined when the element states none. */
function onOf(tag: MobileTag, props: Props, role: string | undefined): boolean | 'mixed' | undefined {
  // The hosts themselves — React Native's Switch, the checkbox libraries —
  // carry the state as `value`.
  if ((tag === 'Switch' || tag === 'Checkbox') && typeof props.value === 'boolean') return props.value;
  const state = a11yState(props);
  if (state.checked === true || state.checked === false || state.checked === 'mixed') return state.checked;
  // A tab or segment says which one is chosen with `selected`; only the
  // chosen one is marked, as the format describes.
  if ((role === 'tab' || props.accessibilityRole === 'tab') && state.selected === true) return true;
  return undefined;
}

/**
 * A font weight, 100 … 900.
 *
 * From `fontWeight` when the app sets it, in any of the forms React Native
 * takes; otherwise from the family's name, because a custom font is usually
 * one family per weight (`Inter-SemiBold`) with no `fontWeight` at all.
 */
const WEIGHT_WORDS: Record<string, number> = {
  normal: 400, regular: 400, bold: 700, ultralight: 200, thin: 100, light: 300,
  medium: 500, semibold: 600, condensedbold: 700, condensed: 400, heavy: 800, black: 900,
};
const FAMILY_WEIGHTS: [RegExp, number][] = [
  [/hairline|thin/i, 100], [/(extra|ultra)[-_ ]?light/i, 200], [/(semi|demi)[-_ ]?bold/i, 600],
  [/(extra|ultra)[-_ ]?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700], [/medium/i, 500], [/light/i, 300],
];

function fontWeightOf(style: Props): number | undefined {
  const raw = style.fontWeight;
  let weight: number | undefined;
  if (typeof raw === 'number') weight = raw;
  else if (typeof raw === 'string') weight = /^[0-9]+$/.test(raw) ? Number(raw) : WEIGHT_WORDS[raw.toLowerCase()];
  else if (typeof style.fontFamily === 'string') {
    weight = FAMILY_WEIGHTS.find(([pattern]) => pattern.test(style.fontFamily as string))?.[1];
  }
  if (weight === undefined || !Number.isFinite(weight)) return undefined;
  return Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
}

/**
 * Which kind of typeface, from its name. Only the kind: the format carries a
 * hint (`mono`, `serif`, `rounded`, `system`), never a font's name, so a
 * custom family the reader does not have still draws in the right spirit.
 * A family that says none of these is left out — the reader's default.
 */
function fontHintOf(style: Props): 'system' | 'serif' | 'mono' | 'rounded' | undefined {
  const family = style.fontFamily;
  if (typeof family !== 'string' || !family) return undefined;
  if (/mono|courier|menlo|consolas|monaco|code/i.test(family)) return 'mono';
  if (/rounded|nunito|quicksand|varela ?round|comfortaa/i.test(family)) return 'rounded';
  if (/sans/i.test(family)) return /^(sans-serif|ui-sans-serif)$/i.test(family) ? 'system' : undefined;
  if (/serif|georgia|times|garamond|baskerville|palatino|merriweather|playfair|lora|didot/i.test(family)) return 'serif';
  if (/^(system|system-ui|-apple-system|ui-default)$/i.test(family)) return 'system';
  return undefined;
}

const ALIGNS = new Set(['left', 'center', 'right', 'justify']);

/**
 * How many lines a text was laid out on.
 *
 * React Native wraps a `<Text>` freely unless `numberOfLines` stops it, and a
 * reader draws a text with no `lines` as one clipped line — so a paragraph
 * replayed as its first line. The laid-out line count is not readable without
 * a layout callback on the app's own component, so it is estimated from the
 * box: its height over the line height (the style's, or 1.2 × the font size,
 * which is what both platforms' default leading comes to), capped by
 * `numberOfLines`. Off by one at worst for unusual leading, which a reader
 * absorbs by clipping to the box anyway.
 */
function linesOf(props: Props, style: Props, height: number): number | undefined {
  const fontSize = typeof style.fontSize === 'number' && style.fontSize > 0 ? style.fontSize : 14;
  const lineHeight = typeof style.lineHeight === 'number' && style.lineHeight > 0 ? style.lineHeight : fontSize * 1.2;
  let lines = Math.max(1, Math.round(height / lineHeight));
  const cap = props.numberOfLines;
  if (typeof cap === 'number' && cap > 0) lines = Math.min(lines, Math.floor(cap));
  return lines > 1 ? Math.min(1000, lines) : undefined;
}

/** A number for `val`/`min`/`max`, rounded so a slider being dragged does not send sixteen digits. */
function rangeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;
}

function rangeOf(type: string, tag: MobileTag, props: Props): CapturedElement['range'] | undefined {
  if (tag === 'Slider') {
    return {
      ...(rangeNumber(props.value) !== undefined ? { val: rangeNumber(props.value) } : {}),
      min: rangeNumber(props.minimumValue) ?? 0,
      max: rangeNumber(props.maximumValue) ?? 1,
    };
  }
  if (tag === 'Progress') {
    // A spinner (ActivityIndicator, Android's indeterminate bar) has no value,
    // which the format reads as indeterminate. A determinate bar has one.
    const determinate = type !== 'RCTActivityIndicatorView' && type !== 'ActivityIndicatorView'
      && props.indeterminate !== true && rangeNumber(props.progress) !== undefined;
    return determinate ? { val: rangeNumber(props.progress), min: 0, max: 1 } : {};
  }
  return undefined;
}

/** The content container React Native puts inside every scroll view. */
const SCROLL_CONTENT = new Set(['RCTScrollContentView', 'AndroidHorizontalScrollContentView']);

/** Elements whose own drawing is their state: what is inside them is not recorded. */
const SELF_DRAWN = new Set<MobileTag>(['Switch', 'Checkbox', 'Slider', 'Progress']);

function isHiddenHost(type: string, props: Props, style: Props): boolean {
  if (style.display === 'none') return true;
  if (style.opacity === 0) return true;
  // A stopped ActivityIndicator is hidden unless the app asked to keep it.
  if (tagFor(type) === 'Progress' && props.animating === false && props.hidesWhenStopped !== false) return true;
  // react-native-screens keeps inactive screens mounted and detaches their
  // views natively. The shadow tree still lays them out where they would be,
  // so without this every tab would be drawn on top of every other.
  if ((type === 'RNSScreen' || type === 'RNSModalScreen') && props.activityState === 0) return true;
  return false;
}

function isHiddenOffscreen(fiber: Fiber): boolean {
  return fiber.tag === OFFSCREEN && (fiber.memoizedProps as Props | null)?.mode === 'hidden';
}

/** The host components directly below a fiber, looking through components. */
function hostChildren(fiber: Fiber): Fiber[] {
  const out: Fiber[] = [];
  const stack: Fiber[] = fiber.child ? [fiber.child] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.sibling) stack.push(node.sibling);
    if (node.tag === HOST_COMPONENT) out.push(node);
    else if (node.child && !isHiddenOffscreen(node)) stack.push(node.child);
  }
  return out;
}

/** Every string below a `<Text>`, in reading order, through nested `<Text>`s. */
function textOf(fiber: Fiber): string {
  let out = '';
  const stack: Fiber[] = fiber.child ? [fiber.child] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.sibling) stack.push(node.sibling);
    if (isHiddenOffscreen(node)) continue;
    if (node.tag === HOST_TEXT) {
      const value = node.memoizedProps;
      if (typeof value === 'string' || typeof value === 'number') out += String(value);
      continue;
    }
    if (node.child) stack.push(node.child);
  }
  return out;
}

/**
 * Icon fonts — Ionicons, Material, FontAwesome — draw their glyphs from
 * Unicode's Private Use Area. The code points mean nothing without the font,
 * so they would replay as boxes of tofu and be sent to a translator as text.
 */
const PRIVATE_USE = /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;

/**
 * A colour as CSS, from either form a native prop carries.
 *
 * Style props arrive as the strings the app wrote. Props an Expo module or a
 * native component takes directly — gradient stops, image border colours —
 * arrive already through `processColor`, as a number packing 0xAARRGGBB.
 */
function anyColour(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === 'transparent' ? 'rgba(0,0,0,0)' : colour(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = value >>> 0;
  const alpha = Math.round((((n >>> 24) & 255) / 255) * 1000) / 1000;
  return `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${alpha})`;
}

/** React Native `resizeMode` and expo-image `contentFit`, as CSS `object-fit`. */
const FIT: Record<string, string> = {
  cover: 'cover', contain: 'contain', fill: 'fill', stretch: 'fill',
  none: 'none', center: 'none', 'scale-down': 'scale-down', repeat: 'cover',
};

/** Hosts a reviewer's browser cannot reach: the device itself and the dev server. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])$/;

/**
 * Whether a reviewer's browser could load this image.
 *
 * Only http(s) on a public host. Everything else — `file://` paths inside the
 * app or its caches, the photo library, data URIs, the Metro server on
 * localhost — is either unreachable from the dashboard or, for picked photos,
 * exactly the kind of thing that must not leave the device as a side effect.
 */
function isRemote(uri: string): boolean {
  if (uri.length > 2048) return false;
  const match = /^https?:\/\/([^/:?#]+)/i.exec(uri);
  return match !== null && !LOCAL_HOST.test(match[1]!.toLowerCase());
}

function imageOf(props: Props, style: Props): { src?: string; fit?: string; local?: string } {
  // React Native's Image and expo-image both hand native an array of sources.
  const sources: unknown[] = Array.isArray(props.source) ? props.source : [props.source ?? props.src];
  let src: string | undefined;
  let local: string | undefined;
  for (const source of sources) {
    const uri = typeof source === 'string' ? source : (source as Props | null)?.uri;
    if (typeof uri !== 'string') continue;
    if (isRemote(uri)) { src = uri; break; }
    local ??= uri;
  }
  const rawFit = props.contentFit ?? props.resizeMode ?? style.resizeMode ?? style.objectFit;
  const fit = typeof rawFit === 'string' ? FIT[rawFit] : undefined;
  return { ...(src ? { src } : {}), ...(fit ? { fit } : {}), ...(!src && local ? { local } : {}) };
}

/** expo-linear-gradient and react-native-linear-gradient, as `x0,y0,x1,y1|colour@location|…`. */
function gradientOf(type: string, props: Props): string | undefined {
  if (!type.includes('LinearGradient') || !Array.isArray(props.colors)) return undefined;
  const colours = props.colors.map(anyColour);
  if (colours.length < 2 || colours.length > 12 || colours.some((c) => c === undefined)) return undefined;
  const point = (value: unknown, fallback: [number, number]): [number, number] => {
    const pair = Array.isArray(value) ? value : (value as { x?: unknown; y?: unknown } | null)
      ? [(value as { x?: unknown }).x, (value as { y?: unknown }).y] : [];
    return pair.length === 2 && pair.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? [pair[0] as number, pair[1] as number] : fallback;
  };
  const [x0, y0] = point(props.startPoint ?? props.start, [0.5, 0]);
  const [x1, y1] = point(props.endPoint ?? props.end, [0.5, 1]);
  const locations = Array.isArray(props.locations) ? props.locations : [];
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const stops = colours.map((c, i) => {
    const at = locations[i];
    return typeof at === 'number' && Number.isFinite(at) ? `${c}@${round(at)}` : c!;
  });
  return [[x0, y0, x1, y1].map(round).join(','), ...stops].join('|');
}

function labelsOf(props: Props): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  if (typeof props.placeholder === 'string' && props.placeholder) labels.placeholder = props.placeholder;
  // Named as the server's extractor already reads them, so these are translated
  // without teaching it anything about phones.
  const aria = props.accessibilityLabel ?? props['aria-label'];
  if (typeof aria === 'string' && aria) labels['aria-label'] = aria;
  if (typeof props.alt === 'string' && props.alt) labels.alt = props.alt;
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function intersects(rect: Rect, clip: Rect): boolean {
  return rect.x < clip.x + clip.width && rect.x + rect.width > clip.x
    && rect.y < clip.y + clip.height && rect.y + rect.height > clip.y;
}

function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x, y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

interface Frame {
  fiber: Fiber;
  /** The element this fiber's boxes attach to. */
  parent: CapturedElement;
  /** That element's position in window coordinates. */
  origin: Rect;
  /** What an ancestor scroll view or clipping view leaves visible. */
  clip: Rect;
  /** Whether an ancestor asked for everything below it to be masked. */
  masked: boolean;
  /**
   * The opacity of views above this one that were not recorded. The format
   * multiplies `op` down the recorded tree, so a wrapper that dims its
   * children without drawing anything hands its opacity to the first one
   * that is recorded.
   */
  opacity: number;
}

/**
 * The registry the serialiser expects, read from a committed fiber tree.
 *
 * Geometry is measured in window coordinates and stored relative to the
 * nearest *recorded* ancestor, which is the shape the wire format and the
 * player already use. Views that draw nothing — no background, no border, no
 * label, not a control — are not recorded: they are most of any React Native
 * tree, they would be invisible on the replay anyway, and leaving them out is
 * most of what keeps a session small. Their children attach to whatever is
 * above them.
 */
export function captureTree(
  root: Fiber,
  ids: FiberIds,
  options: CaptureOptions,
): { elements: Map<number, CapturedElement>; rootId: number; layers: number[] } {
  const { screen } = options;
  const full: Rect = { x: 0, y: 0, width: screen.width, height: screen.height };
  const rootElement: CapturedElement = { id: ROOT_ELEMENT_ID, tag: 'View', rect: full, children: [] };
  const elements = new Map<number, CapturedElement>([[ROOT_ELEMENT_ID, rootElement]]);
  const covered = new WeakSet<Fiber>();
  /** Modals, which hang from `Screen` itself (see `serialise`). */
  const layers: number[] = [];

  // Iterative, not recursive: a navigation-heavy app nests components deeply
  // enough to matter on a JavaScript stack, and a recorder must never be the
  // reason an app overflows one.
  const stack: Frame[] = [];
  if (root.child) stack.push({ fiber: root.child, parent: rootElement, origin: full, clip: full, masked: false, opacity: 1 });

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { fiber } = frame;
    if (fiber.sibling) stack.push({ ...frame, fiber: fiber.sibling });

    const descend = (next: Partial<Frame> = {}): void => {
      if (fiber.child) stack.push({ ...frame, ...next, fiber: fiber.child });
    };

    if (isHiddenOffscreen(fiber)) continue;
    if (fiber.tag === HOST_TEXT) continue; // React Native only renders strings inside <Text>.
    if (fiber.tag !== HOST_COMPONENT || typeof fiber.type !== 'string') {
      descend();
      continue;
    }
    if (covered.has(fiber)) continue;

    const type = fiber.type;
    const props = (fiber.memoizedProps ?? {}) as Props;
    const style = flattenStyle(props.style);
    if (type === 'RCTVirtualText') continue; // Read by the enclosing <Text>.
    if (isHiddenHost(type, props, style)) continue;

    if (type === 'RNSScreenStack') {
      // Every screen in a native stack stays mounted. Only the top card and
      // anything presented over it is on screen.
      const screens = hostChildren(fiber).filter((c) => c.type === 'RNSScreen' || c.type === 'RNSModalScreen');
      let top = -1;
      screens.forEach((s, i) => {
        const presentation = (s.memoizedProps as Props | null)?.stackPresentation;
        if (presentation === undefined || presentation === 'push') top = i;
      });
      for (let i = 0; i < top; i += 1) covered.add(screens[i]!);
    }

    let tag = hostTag(type, props);
    const testID = typeof props.testID === 'string' ? props.testID : '';
    /**
     * What this element may carry off the device.
     *
     * A `TextInput` is recorded by default, as on the web, and masked when the
     * app asked for that — `maskAllTyping` is the stricter of the two and wins,
     * so an app that set it does not get field values back because
     * `maskAllInputs: false` is also set somewhere else — or when the floor
     * covers it: `secureTextEntry`, a hint that names a credential, a one-time
     * code or a payment instrument, or a value shaped like a card number.
     */
    const masked = frame.masked
      || testID.includes(options.maskTestID)
      || props.secureTextEntry === true
      || (tag === 'TextInput' && (
        options.maskAllInputs
        || options.maskAllTyping === true
        || isSensitiveField(props)
        || looksLikeCardNumber(fieldValue(props))
      ))
      || (options.maskImages === true && tag === 'Image');

    // A modal is presented in a window of its own, over the whole screen:
    // where React rendered it in the tree says nothing about where it is
    // drawn, and the shadow tree places it at the screen's origin anyway.
    const isModal = tag === 'Modal';
    const rect = isModal ? full : options.measure(fiber);
    const visible = rect !== null && rect.width > 0 && rect.height > 0 && intersects(rect, isModal ? full : frame.clip);

    const isLeaf = tag === 'Text' || tag === 'TextInput';
    if (isLeaf && !visible) continue;

    const role = rawRole(props);
    // A small view that says it is a checkbox, a radio button or a switch is
    // drawn as one. A whole row that says so is not: a reader draws a
    // Checkbox as a box filled when on, which a list row is not — the row
    // keeps its tag and carries `on`, and its words stay its words.
    if (rect && (tag === 'View' || tag === 'Pressable' || tag === 'Unknown')) {
      if ((role === 'checkbox' || role === 'radio') && rect.width <= 48 && rect.height <= 48) tag = 'Checkbox';
      else if (role === 'switch' && rect.width <= 80 && rect.height <= 48) tag = 'Switch';
    }

    const labels = labelsOf(props);
    const background = colour(style.backgroundColor);
    const gradient = gradientOf(type, props);
    const bordered = typeof style.borderWidth === 'number' && style.borderWidth > 0;
    const mappedRole = role ? ROLES[role] : undefined;
    const on = onOf(tag, props, role);
    const disabled = a11yState(props).disabled === true || props.disabled === true
      || (tag === 'TextInput' && props.editable === false);
    const worthRecording = isLeaf || tag !== 'View' && tag !== 'Unknown'
      || background !== undefined || gradient !== undefined || bordered
      || labels !== undefined || (mappedRole !== undefined && mappedRole !== 'header') || on !== undefined;
    const ownOpacity = typeof style.opacity === 'number' && style.opacity > 0 && style.opacity < 1 ? style.opacity : 1;
    const opacity = frame.opacity * ownOpacity;

    const clips = tag === 'ScrollView' || isModal || style.overflow === 'hidden' || style.overflow === 'scroll';
    const clip = clips && rect ? intersection(isModal ? full : frame.clip, rect) : frame.clip;
    const childMask = masked && tag !== 'TextInput';

    if (!visible || !worthRecording) {
      descend({ clip, masked: childMask, opacity });
      continue;
    }

    const id = ids.idFor(fiber);
    // A layer's position is relative to the screen it hangs from.
    const origin = isModal ? full : frame.origin;
    const element: CapturedElement = {
      id,
      tag,
      rect: {
        x: rect.x - origin.x,
        y: rect.y - origin.y,
        width: rect.width,
        height: rect.height,
      },
      labels,
      masked,
      children: [],
    };
    if (mappedRole) element.role = mappedRole;
    if (disabled) element.disabled = true;
    if (on !== undefined) element.on = on;
    const range = rangeOf(type, tag, props);
    if (range) element.range = range;

    const visual: NonNullable<CapturedElement['style']> = {};
    if (background) visual.backgroundColor = background;
    if (gradient) visual.gradient = gradient;
    if (typeof style.borderRadius === 'number' && style.borderRadius > 0) visual.radius = style.borderRadius;
    if (bordered) {
      visual.borderWidth = style.borderWidth as number;
      // An image's border colour reaches native already processed.
      const borderColour = anyColour(props.borderColor ?? style.borderColor);
      if (borderColour) visual.borderColor = borderColour;
    }
    if (tag === 'Text' || tag === 'TextInput') {
      const color = colour(style.color);
      if (color) visual.color = color;
      if (typeof style.fontSize === 'number') visual.fontSize = style.fontSize;
      const weight = fontWeightOf(style);
      if (weight !== undefined) visual.fontWeight = weight;
      const hint = fontHintOf(style);
      if (hint) visual.fontHint = hint;
      if (style.fontStyle === 'italic') visual.italic = true;
      if (typeof style.textAlign === 'string' && ALIGNS.has(style.textAlign)) {
        visual.align = style.textAlign as NonNullable<typeof visual.align>;
      }
      if (tag === 'Text') {
        const lines = linesOf(props, style, rect.height);
        if (lines) visual.lines = lines;
      }
    }
    if (opacity < 1) visual.opacity = Math.max(0.01, Math.round(opacity * 100) / 100);
    if (typeof style.zIndex === 'number' && Number.isInteger(style.zIndex) && style.zIndex !== 0) {
      visual.zIndex = Math.max(-1000, Math.min(1000, style.zIndex));
    }
    if (Object.keys(visual).length > 0) element.style = visual;

    if (tag === 'Text') {
      const raw = textOf(fiber);
      const text = raw.replace(PRIVATE_USE, '').trim();
      if (text) {
        element.text = text;
      } else if (raw) {
        // Only an icon-font glyph. The glyph and its font are recorded so the
        // player can draw the icon itself; neither is prose, and neither is
        // offered to the translator — nor is how its "words" are set.
        element.tag = 'Icon';
        element.icon = {
          glyph: raw.trim().slice(0, 8),
          ...(typeof style.fontFamily === 'string' ? { font: style.fontFamily.slice(0, 64) } : {}),
        };
        if (element.style) {
          delete element.style.fontWeight; delete element.style.fontHint; delete element.style.italic;
          delete element.style.align; delete element.style.lines;
        }
      }
    } else if (tag === 'Image') {
      const { local, ...image } = imageOf(props, style);
      if (masked) delete image.src;
      // The app's own images only, and only once uploaded: the hash is how the
      // dashboard asks for the file. Nothing is read for a masked image.
      if (!masked && local && options.assetFor && isBundledAsset(local)) {
        const asset = options.assetFor(local);
        if (asset) (image as { asset?: string }).asset = asset;
      }
      if (image.src || image.fit || (image as { asset?: string }).asset) element.image = image;
    } else if (tag === 'TextInput') {
      // Masked or not, the value is carried as the element's text and replaced
      // by `serialise`, which is the last point before anything leaves the
      // device: a masked field still replays as a field being filled in.
      const value = fieldValue(props);
      if (value) element.text = value;
    }

    elements.set(id, element);
    // A modal hangs from the screen itself, wherever React rendered it — a
    // modal opened from inside another one included: both are layers over the
    // screen, and the later one is drawn on top, as it was presented.
    if (isModal) layers.push(id);
    else frame.parent.children.push(id);

    // A text's children are its words, already read; a field's are its
    // formatted value, which is the thing being masked. An opaque area is
    // never looked inside, and a switch, checkbox, slider or spinner is drawn
    // from its state, not from the views that draw it natively.
    if (isLeaf || OPAQUE_TAGS.has(tag) || SELF_DRAWN.has(tag)) continue;

    // Inside a scroll view, children are placed in content coordinates
    // (MOBILE-REPLAY-FORMAT §6): relative to the content container React
    // Native puts inside every scroll view, wherever it has scrolled to. The
    // container's position *is* the scroll position: Fabric measures it
    // through the scroll view's offset, so the scroll view's top minus the
    // container's top is how far the content has scrolled. Without a
    // container (a custom scroll host) the offset is 0 and children stay
    // where they were seen — which is what 0 means.
    let childOrigin: Rect = rect;
    if (tag === 'ScrollView') {
      const content = hostChildren(fiber).find((c) => typeof c.type === 'string' && SCROLL_CONTENT.has(c.type));
      const contentRect = content ? options.measure(content) : null;
      if (contentRect) {
        childOrigin = contentRect;
        element.scroll = { x: rect.x - contentRect.x, y: rect.y - contentRect.y };
      } else {
        element.scroll = { x: 0, y: 0 };
      }
    }
    descend({ parent: element, origin: childOrigin, clip, masked: childMask, opacity: 1 });
  }

  return { elements, rootId: ROOT_ELEMENT_ID, layers };
}

