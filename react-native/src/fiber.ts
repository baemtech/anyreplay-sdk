import { isBundledAsset } from './assets.js';
import { fieldValue, isSensitiveField, looksLikeCardNumber } from './masking.js';
import { tagFor, type CapturedElement, type Rect } from './tree.js';
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

function hostTag(type: string, props: Props): MobileTag {
  const base = tagFor(type);
  if (base !== 'View' && base !== 'Unknown') return base;
  // Pressable and the Touchables render a plain view. What makes one a button
  // is what it answers to, and accessibility role is the most direct statement
  // of that when the app gives one.
  if (props.accessibilityRole === 'button' || props.role === 'button') return 'Pressable';
  if (props.accessible === true
    && (typeof props.onClick === 'function' || typeof props.onResponderRelease === 'function')) {
    return 'Pressable';
  }
  return base;
}

function isHiddenHost(type: string, props: Props, style: Props): boolean {
  if (style.display === 'none') return true;
  if (style.opacity === 0) return true;
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
): { elements: Map<number, CapturedElement>; rootId: number } {
  const { screen } = options;
  const full: Rect = { x: 0, y: 0, width: screen.width, height: screen.height };
  const rootElement: CapturedElement = { id: ROOT_ELEMENT_ID, tag: 'View', rect: full, children: [] };
  const elements = new Map<number, CapturedElement>([[ROOT_ELEMENT_ID, rootElement]]);
  const covered = new WeakSet<Fiber>();

  // Iterative, not recursive: a navigation-heavy app nests components deeply
  // enough to matter on a JavaScript stack, and a recorder must never be the
  // reason an app overflows one.
  const stack: Frame[] = [];
  if (root.child) stack.push({ fiber: root.child, parent: rootElement, origin: full, clip: full, masked: false });

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

    const tag = hostTag(type, props);
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

    const rect = options.measure(fiber);
    const visible = rect !== null && rect.width > 0 && rect.height > 0 && intersects(rect, frame.clip);

    const isLeaf = tag === 'Text' || tag === 'TextInput';
    if (isLeaf && !visible) continue;

    const labels = labelsOf(props);
    const background = colour(style.backgroundColor);
    const gradient = gradientOf(type, props);
    const bordered = typeof style.borderWidth === 'number' && style.borderWidth > 0;
    const worthRecording = isLeaf || tag === 'Image' || tag === 'Pressable' || tag === 'Switch'
      || tag === 'ScrollView' || background !== undefined || gradient !== undefined || bordered
      || labels !== undefined;

    const clips = tag === 'ScrollView' || style.overflow === 'hidden' || style.overflow === 'scroll';
    const clip = clips && rect ? intersection(frame.clip, rect) : frame.clip;
    const childMask = masked && tag !== 'TextInput';

    if (!visible || !worthRecording) {
      descend({ clip, masked: childMask });
      continue;
    }

    const id = ids.idFor(fiber);
    const element: CapturedElement = {
      id,
      tag,
      rect: {
        x: rect.x - frame.origin.x,
        y: rect.y - frame.origin.y,
        width: rect.width,
        height: rect.height,
      },
      labels,
      masked,
      children: [],
    };

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
        // offered to the translator.
        element.tag = 'Icon';
        element.icon = {
          glyph: raw.trim().slice(0, 8),
          ...(typeof style.fontFamily === 'string' ? { font: style.fontFamily.slice(0, 64) } : {}),
        };
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
    frame.parent.children.push(id);

    // A text's children are its words, already read; a field's are its
    // formatted value, which is the thing being masked.
    if (!isLeaf) descend({ parent: element, origin: rect, clip, masked: childMask });
  }

  return { elements, rootId: ROOT_ELEMENT_ID };
}
