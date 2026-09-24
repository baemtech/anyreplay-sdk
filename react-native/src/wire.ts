/**
 * The recording format, shared with the web recorder on purpose.
 *
 * A mobile session is serialised into the same node and event shapes rrweb
 * produces for a page. Nothing about that is cosmetic: the server's string
 * extraction, the translation cache, the retention sweeper and the session
 * index all walk this structure already, so a recording that arrives in it is
 * translatable and searchable on the day it lands, with no server change at
 * all. A bespoke mobile format would have meant reimplementing every one of
 * those, and reimplementing the extraction is how the translation cache stops
 * being shared between a customer's site and their app.
 *
 * Where the analogy has to bend it bends towards the web: a React Native
 * `<Text>` becomes an element node whose child is a text node, exactly as a
 * `<span>` would, because that is the shape `extractStrings` knows how to read.
 */

/** rrweb serialised node types. Kept numerically identical. */
export const NODE = { document: 0, doctype: 1, element: 2, text: 3, cdata: 4, comment: 5 } as const;

/** rrweb event types. Only the three a mobile session can produce. */
export const EVENT = { meta: 4, fullSnapshot: 2, incremental: 3 } as const;

/** rrweb incremental sources. Mutation and touch are all a phone needs. */
export const SOURCE = { mutation: 0, touchMove: 2, mouseInteraction: 2, scroll: 3, input: 5 } as const;

/**
 * Element tag names a mobile snapshot may contain.
 *
 * Deliberately small and native-flavoured rather than mapped onto HTML. The
 * player draws boxes from these; calling a `<Text>` a `<span>` would buy
 * nothing and lose the one fact the renderer needs.
 */
export type MobileTag =
  | 'Screen' | 'View' | 'Text' | 'TextInput' | 'Image' | 'Icon' | 'Pressable'
  | 'ScrollView' | 'Switch' | 'Unknown';

export interface MobileNode {
  type: number;
  id: number;
  tagName?: MobileTag;
  /** Layout in points, relative to the screen, plus presentation. */
  attributes?: Record<string, string | number | boolean>;
  childNodes?: MobileNode[];
  textContent?: string;
}

export interface RecordedEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

/** Everything the first chunk of a session tells the server about it. */
export interface SessionMeta {
  startedAt: number;
  /** The screen name, in the field the web recorder uses for the page URL. */
  url?: string;
  lang?: string;
  userAgent?: string;
  screenWidth?: number;
  screenHeight?: number;
  referrer?: string;
}

export interface ChunkFlags {
  hasError?: boolean;
  hasRageClick?: boolean;
  pageCount?: number;
}

/**
 * The agent string a mobile session reports.
 *
 * Shaped so the server's existing classifier reads it without a special case:
 * it already looks for "iphone"/"android" to decide the operating system and
 * the device class. The leading token is what tells a reviewer, looking at a
 * session list of mixed web and app traffic, which is which.
 */
export function userAgent(platform: string, version: string, model?: string): string {
  const os = platform === 'ios' ? 'iPhone; iOS' : platform === 'android' ? 'Android' : platform;
  return `AnyReplayRN/0.1 (${os} ${version}${model ? `; ${model}` : ''}) Mobile`;
}
