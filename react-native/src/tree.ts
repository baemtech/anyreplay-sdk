import { NODE, type MobileNode, type MobileTag } from './wire.js';

/**
 * Turning what React Native rendered into something replayable.
 *
 * There is no DOM to walk, so the tree is built from the React elements the app
 * returns, captured as they are created, plus the geometry the layout engine
 * reports back. That combination is the whole trick: React knows *what* is on
 * screen and what it says, the layout pass knows *where* it is, and neither
 * alone is enough.
 *
 * The alternative every other mobile recorder takes is screenshots. It is
 * simpler and it is wrong for this product: a screenshot is pixels, and pixels
 * cannot be translated. A tool whose reason to exist is showing a reviewer a
 * session in their own language cannot record its mobile sessions in a form
 * where the words have been thrown away.
 */

export interface Rect { x: number; y: number; width: number; height: number }

/** What the recorder was told, or worked out, about one rendered element. */
export interface CapturedElement {
  /** Even. The element's text node, when it has one, takes the next odd id. */
  id: number;
  tag: MobileTag;
  /** Absent until the layout pass has reported it. */
  rect?: Rect;
  text?: string;
  /** Placeholder, accessibility label — the strings that are not children. */
  labels?: Record<string, string>;
  style?: {
    color?: string;
    backgroundColor?: string;
    fontSize?: number;
    opacity?: number;
    /** `x0,y0,x1,y1|colour@location|…`, in the element's unit square. */
    gradient?: string;
    radius?: number;
    borderWidth?: number;
    borderColor?: string;
  };
  /**
   * What an image showed.
   *
   * `src` is only ever a URL a reviewer's browser can load — the app's own
   * files and the development server are not — and is never set on a masked
   * image.
   */
  image?: { src?: string; fit?: string; asset?: string };
  /** An icon-font glyph and the font that draws it. */
  icon?: { glyph: string; font?: string };
  /** True when the value must never leave the device. */
  masked?: boolean;
  children: number[];
}

/**
 * The React Native components worth distinguishing.
 *
 * Everything else collapses to `View` or `Unknown`. A wireframe does not need
 * to know that something was a `SafeAreaView`; it needs to know whether to draw
 * a box, a line of text, or a redaction block.
 */
const TAGS: Record<string, MobileTag> = {
  View: 'View', RCTView: 'View', SafeAreaView: 'View',
  Text: 'Text', RCTText: 'Text', RCTVirtualText: 'Text',
  TextInput: 'TextInput', RCTTextInput: 'TextInput', AndroidTextInput: 'TextInput',
  RCTSinglelineTextInputView: 'TextInput', RCTMultilineTextInputView: 'TextInput',
  Image: 'Image', RCTImageView: 'Image', RCTImage: 'Image',
  Pressable: 'Pressable', TouchableOpacity: 'Pressable', TouchableHighlight: 'Pressable',
  TouchableWithoutFeedback: 'Pressable', Button: 'Pressable',
  ScrollView: 'ScrollView', RCTScrollView: 'ScrollView', FlatList: 'ScrollView',
  Switch: 'Switch', RCTSwitch: 'Switch', AndroidSwitch: 'Switch',
};

export function tagFor(componentName: string): MobileTag {
  const known = TAGS[componentName];
  if (known) return known;
  // Image libraries register their own hosts (expo-image, FastImage); what they
  // have in common is the word.
  if (componentName.includes('Image')) return 'Image';
  return componentName.endsWith('View') ? 'View' : 'Unknown';
}

const MASK = '••••••';

/**
 * Builds the serialised tree from a registry of captured elements.
 *
 * Elements whose layout never arrived are dropped rather than guessed at: a box
 * drawn at the wrong place is worse than a box that is missing, because a
 * reviewer cannot tell the first from the truth.
 */
export function serialise(
  elements: Map<number, CapturedElement>,
  rootId: number,
  screen: { width: number; height: number },
): MobileNode {
  const visit = (id: number): MobileNode | null => {
    const element = elements.get(id);
    if (!element) return null;
    if (!element.rect) return null;
    if (element.rect.width <= 0 || element.rect.height <= 0) return null;

    const attributes: Record<string, string | number | boolean> = {
      x: Math.round(element.rect.x),
      y: Math.round(element.rect.y),
      w: Math.round(element.rect.width),
      h: Math.round(element.rect.height),
    };
    if (element.style?.color) attributes.color = element.style.color;
    if (element.style?.backgroundColor) attributes.bg = element.style.backgroundColor;
    if (element.style?.fontSize) attributes.size = element.style.fontSize;
    if (element.style?.gradient) attributes.grad = element.style.gradient;
    if (element.style?.radius) attributes.r = Math.round(element.style.radius * 10) / 10;
    if (element.style?.borderWidth) attributes.bw = element.style.borderWidth;
    if (element.style?.borderColor) attributes.bc = element.style.borderColor;
    if (element.image?.fit) attributes.fit = element.image.fit;
    // Checked again here, not only where it was captured: this is the last
    // point before the value leaves the device.
    if (element.image?.src && !element.masked) attributes.src = element.image.src;
    if (element.image?.asset && !element.masked) attributes.asset = element.image.asset;
    if (element.icon) {
      attributes.glyph = element.icon.glyph;
      if (element.icon.font) attributes.font = element.icon.font;
    }
    if (element.masked) attributes.masked = true;

    // Placeholder and accessibility label are prose a reviewer wants
    // translated, and the server already knows to look for them under these
    // names — they are two of the attributes its extractor reads.
    //
    // A placeholder is the app's own copy, never something a person typed, so
    // it survives masking — as it does in the web recorder. Without it a masked
    // form replays as a column of identical striped boxes and the reviewer
    // cannot tell the name field from the password field. An accessibility
    // label can carry the value it describes, so it is masked with the element.
    for (const [name, value] of Object.entries(element.labels ?? {})) {
      if (!value) continue;
      attributes[name] = element.masked && name !== 'placeholder' ? MASK : value;
    }

    const childNodes: MobileNode[] = [];

    // A masked element keeps its box and loses its words. The reviewer still
    // sees that something was typed, and where, which is usually the whole
    // question — without ever seeing what.
    if (element.text !== undefined) {
      childNodes.push({
        type: NODE.text,
        id: id + 1,
        textContent: element.masked ? MASK : element.text,
      });
    }

    for (const childId of element.children) {
      const child = visit(childId);
      if (child) childNodes.push(child);
    }

    return { type: NODE.element, id, tagName: element.tag, attributes, childNodes };
  };

  const root = visit(rootId);
  return {
    type: NODE.element,
    id: 1,
    tagName: 'Screen',
    attributes: { x: 0, y: 0, w: Math.round(screen.width), h: Math.round(screen.height) },
    childNodes: root ? [root] : [],
  };
}

/**
 * What changed between two serialised trees.
 *
 * Sent instead of a whole snapshot on every frame, which is the difference
 * between a session costing kilobytes and costing megabytes. A phone re-renders
 * constantly and almost nothing moves; shipping the parts that did is the
 * single biggest lever on what a recorded session costs to carry and to keep.
 */
export interface Mutation {
  /** Nodes whose attributes changed, with only the changed keys. */
  attributes: { id: number; attributes: Record<string, string | number | boolean> }[];
  /** Text nodes whose content changed. */
  texts: { id: number; value: string }[];
  /** Nodes that appeared, each with its parent. */
  adds: { parentId: number; node: MobileNode }[];
  /** Nodes that went away. */
  removes: { id: number }[];
}

export function diff(before: MobileNode, after: MobileNode): Mutation {
  const mutation: Mutation = { attributes: [], texts: [], adds: [], removes: [] };

  const index = (node: MobileNode, into: Map<number, MobileNode>, parents: Map<number, number>): void => {
    into.set(node.id, node);
    for (const child of node.childNodes ?? []) {
      parents.set(child.id, node.id);
      index(child, into, parents);
    }
  };

  const oldNodes = new Map<number, MobileNode>();
  const oldParents = new Map<number, number>();
  const newNodes = new Map<number, MobileNode>();
  const newParents = new Map<number, number>();
  index(before, oldNodes, oldParents);
  index(after, newNodes, newParents);

  for (const [id, node] of newNodes) {
    const previous = oldNodes.get(id);

    if (!previous) {
      // Only the top of an added subtree is reported: its children travel
      // inside it, and reporting them again would send the same bytes twice.
      const parentId = newParents.get(id);
      if (parentId !== undefined && !newNodes.has(parentId)) continue;
      if (parentId !== undefined && !oldNodes.has(parentId)) continue;
      if (parentId === undefined) continue;
      mutation.adds.push({ parentId, node });
      continue;
    }

    if (node.type === NODE.text) {
      if (node.textContent !== previous.textContent) {
        mutation.texts.push({ id, value: node.textContent ?? '' });
      }
      continue;
    }

    const changed: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(node.attributes ?? {})) {
      if (previous.attributes?.[key] !== value) changed[key] = value;
    }
    if (Object.keys(changed).length > 0) mutation.attributes.push({ id, attributes: changed });
  }

  for (const id of oldNodes.keys()) {
    if (newNodes.has(id)) continue;
    const parentId = oldParents.get(id);
    // Same rule in reverse: a removed subtree is one removal, not one per node.
    if (parentId !== undefined && !oldNodes.has(parentId)) continue;
    if (parentId !== undefined && newNodes.has(parentId)) mutation.removes.push({ id });
  }

  return mutation;
}

export function isEmpty(mutation: Mutation): boolean {
  return mutation.attributes.length === 0 && mutation.texts.length === 0
    && mutation.adds.length === 0 && mutation.removes.length === 0;
}
