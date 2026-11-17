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

/**
 * rrweb event types a mobile session can produce.
 *
 * `custom` is rrweb's own number for it, and carries the same tagged payloads
 * a page sends: `anyreplay.track`, `anyreplay.error`, `anyreplay.console`.
 * Ingest, the player's timeline and the insights detectors read them without
 * knowing which platform recorded them — see `events.ts`.
 */
export const EVENT = { meta: 4, fullSnapshot: 2, incremental: 3, custom: 5 } as const;

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
  | 'ScrollView' | 'Switch' | 'Checkbox' | 'Slider' | 'Progress'
  | 'WebView' | 'Map' | 'Video' | 'Modal' | 'Unknown';

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
  /** Always `react-native` for this SDK; see packages/shared/src/platforms.ts on the server. */
  platform?: string;
  sdk?: { name: string; version: string };
  appVersion?: string;
  /** Android's `Build.MODEL`, from `Platform.constants`. iOS offers none without a native module. */
  deviceModel?: string;
}

export interface ChunkFlags {
  hasError?: boolean;
  hasRageClick?: boolean;
  pageCount?: number;
}

/**
 * Words that change the server's reading of an agent string wherever they
 * appear. A model name containing one is left out, rather than allowed to turn
 * a tablet into a phone ("Tab Mobile 10") or an Android phone into a PC.
 */
const CLASSIFIER_WORDS = /windows|android|iphone|ipad|mobile|macintosh|mac os|linux/i;

/**
 * The agent string a mobile session reports.
 *
 * Shaped so the server's existing classifier reads it without a special case
 * (docs/SDK-CONTRACT.md §2.6): it looks for "iphone"/"ipad"/"android" to
 * decide the operating system, and for "mobile" — or "ipad", or "android"
 * without "mobile" — to decide the device class. So an iPad says `iPad` and an
 * Android tablet says `Tablet` instead of `Mobile`; before this, both were
 * filed as phones. The leading token is what tells a reviewer, looking at a
 * session list of mixed web and app traffic, which is which.
 *
 * The same format as `nativeUserAgent` in the shared conformance package,
 * written out here because the published SDK cannot depend on a private
 * package; the conformance test holds the two together.
 */
export function userAgent(
  platform: string,
  version: string,
  model?: string,
  options: { tablet?: boolean; sdkVersion?: string } = {},
): string {
  const [major = '0', minor = '0'] = (options.sdkVersion ?? '0.1.0').split(/[.-]/);
  const osVersion = version.replace(/[;()]/g, '');
  // On iOS only a hardware identifier (`iPad13,1`) is safe; React Native
  // offers none without a native module, so in practice iOS has no model.
  const safeModel = platform === 'ios'
    ? (model && /^(iPhone|iPad|iPod)[0-9]+,[0-9]+$/.test(model) ? model : undefined)
    : (model && !CLASSIFIER_WORDS.test(model) ? model.replace(/[;()]/g, '').trim() || undefined : undefined);
  const device = platform === 'ios'
    ? `${options.tablet ? 'iPad' : 'iPhone'}; iOS ${osVersion}`
    : platform === 'android' ? `Android ${osVersion}` : `${platform.replace(/[;()]/g, '')} ${osVersion}`;
  return `AnyReplayRN/${major}.${minor} (${device}${safeModel ? `; ${safeModel}` : ''}) ${options.tablet ? 'Tablet' : 'Mobile'}`;
}
