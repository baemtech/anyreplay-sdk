import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { captureTree, currentRootOf, FiberIds, type CaptureOptions, type Fiber } from '../src/fiber.js';
import { serialise, type CapturedElement, type Rect } from '../src/tree.js';

/**
 * The screen is read from React's committed fiber tree, so these tests render
 * with a real React and walk the fibers it really commits. The host component
 * names are React Native's own; the only thing faked is geometry, which each
 * host carries as a `frame` prop in window coordinates.
 */

const h = React.createElement;
const SCREEN = { width: 390, height: 844 };
const OPTIONS: Omit<CaptureOptions, 'measure'> = { screen: SCREEN, maskAllInputs: true, maskTestID: 'ar-mask' };
const measure = (fiber: Fiber): Rect | null =>
  ((fiber.memoizedProps as { frame?: Rect } | null)?.frame) ?? null;
const at = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The renderer announces its own deprecation on every render. It is still the
  // only way to get real committed fibers in Node, and the noise hides failures.
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    original(...args);
  };
});

let renderer: ReactTestRenderer | null = null;
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => { renderer = TestRenderer.create(element); });
  return renderer!;
}

function read(r: ReactTestRenderer, ids = new FiberIds(), options = OPTIONS) {
  const fiber = (r.root as unknown as { _fiber: Fiber })._fiber;
  const root = currentRootOf(fiber);
  if (!root) throw new Error('no root');
  return captureTree(root, ids, { ...options, measure });
}

const all = (captured: { elements: Map<number, CapturedElement> }) => [...captured.elements.values()];
const texts = (captured: { elements: Map<number, CapturedElement> }) =>
  all(captured).filter((e) => e.text !== undefined).map((e) => e.text);

describe('reading the committed tree', () => {
  it('finds text through components, fragments and nested <Text>', () => {
    const Title = ({ name }: { name: string }) => h('RCTText', { frame: at(0, 0, 200, 20) }, 'Merhaba ',
      h('RCTVirtualText', null, name), '!');
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h(React.Fragment, null, h(Title, { name: 'dünya' }))));

    expect(texts(read(r))).toEqual(['Merhaba dünya!']);
  });

  it('keeps a memoised subtree that did not re-render', () => {
    // The bug in capturing elements as they were created: a memoised child is
    // never created again, so it disappeared from the recording on the
    // parent's next render while it stayed on screen.
    const Stable = React.memo(() => h('RCTText', { frame: at(0, 40, 100, 20) }, 'Sabit'));
    let bump: () => void = () => {};
    const App = () => {
      const [n, setN] = React.useState(0);
      bump = () => setN((v) => v + 1);
      return h('RCTView', { frame: at(0, 0, 390, 844) },
        h('RCTText', { frame: at(0, 0, 100, 20) }, `Sayaç ${n}`), h(Stable));
    };
    const r = render(h(App));
    act(() => bump());

    expect(texts(read(r))).toEqual(['Sayaç 1', 'Sabit']);
  });

  it('keeps ids stable across renders and drops what unmounted', () => {
    let toggle: () => void = () => {};
    const App = () => {
      const [open, setOpen] = React.useState(true);
      toggle = () => setOpen(false);
      return h('RCTView', { frame: at(0, 0, 390, 844) },
        h('RCTText', { frame: at(0, 0, 100, 20) }, open ? 'Açık' : 'Kapalı'),
        open ? h('RCTText', { frame: at(0, 30, 100, 20) }, 'Geçici') : null);
    };
    const ids = new FiberIds();
    const r = render(h(App));
    const before = read(r, ids);
    act(() => toggle());
    const after = read(r, ids);

    const idOf = (c: typeof before, text: string) => all(c).find((e) => e.text === text)?.id;
    expect(idOf(after, 'Kapalı')).toBe(idOf(before, 'Açık'));
    expect(texts(after)).toEqual(['Kapalı']);
  });

  it('reads the tree on screen even when started from a stale copy of a fiber', () => {
    let set: (v: string) => void = () => {};
    const App = () => {
      const [label, setLabel] = React.useState('ilk');
      set = setLabel;
      return h('RCTText', { frame: at(0, 0, 100, 20) }, label);
    };
    const r = render(h(App));
    const early = (r.root as unknown as { _fiber: Fiber })._fiber;
    act(() => set('ikinci'));
    act(() => set('üçüncü'));

    const root = currentRootOf(early)!;
    expect(texts(captureTree(root, new FiberIds(), { ...OPTIONS, measure }))).toEqual(['üçüncü']);
  });

  it('stores positions relative to the nearest recorded ancestor', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTView', { frame: at(20, 100, 300, 200), style: [{ backgroundColor: '#fff' }, null] },
        // Draws nothing, so it is not recorded; its child attaches to the card.
        h('RCTView', { frame: at(30, 110, 280, 100) },
          h('RCTText', { frame: at(40, 120, 100, 20) }, 'Kart')))));

    const captured = read(r);
    const card = all(captured).find((e) => e.style?.backgroundColor === '#fff')!;
    const label = all(captured).find((e) => e.text === 'Kart')!;
    expect(card.rect).toEqual(at(20, 100, 300, 200));
    expect(card.children).toEqual([label.id]);
    expect(label.rect).toEqual(at(20, 20, 100, 20));
  });

  it('treats an icon-font glyph as a picture, not as words', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTText', { frame: at(0, 0, 24, 24) }, '\uf5b6'),
      h('RCTText', { frame: at(0, 40, 120, 20) }, '\uf13e Kaydet')));
    const captured = all(read(r));

    expect(texts(read(r))).toEqual(['Kaydet']);
    expect(captured.filter((e) => e.tag === 'Icon')).toHaveLength(1);
    // The glyph is kept as the icon it is, never as words for the translator.
    expect(captured.filter((e) => e.text).map((e) => e.text).join('')).not.toMatch(/[\uE000-\uF8FF]/);
  });

  it('calls a view a button when it says it is one', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 100, 40), accessibilityRole: 'button', accessibilityLabel: 'Kaydet' }));
    const [button] = all(read(r)).filter((e) => e.tag === 'Pressable');
    expect(button?.labels).toEqual({ 'aria-label': 'Kaydet' });
  });
});

describe('pictures', () => {
  const PHOTO = 'https://babymind.baemtech.com/uploads/thumbs/a.jpg';

  it('records the URL an expo-image showed, how it was fitted, and its corners', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('ViewManagerAdapter_ExpoImage_com.baemtech.babymind', {
        frame: at(10, 10, 200, 200), source: [{ uri: PHOTO, width: 800, height: 800 }],
        contentFit: 'cover', style: { borderRadius: 16 },
      })));
    const [image] = all(read(r)).filter((e) => e.tag === 'Image');
    expect(image?.image).toEqual({ src: PHOTO, fit: 'cover' });
    expect(image?.style?.radius).toBe(16);
  });

  it('records a React Native Image the same way', () => {
    const r = render(h('RCTImageView', {
      frame: at(0, 0, 100, 100), source: [{ uri: PHOTO, scale: 3 }], resizeMode: 'contain',
    }));
    expect(all(read(r)).find((e) => e.tag === 'Image')?.image).toEqual({ src: PHOTO, fit: 'contain' });
  });

  it.each([
    ['a file inside the app', 'file:///var/containers/Bundle/Application/X/BabyPix.app/assets/icon.png'],
    ['a photo picked from the library', 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/1.jpg'],
    ['the development server', 'http://localhost:8081/assets/images/icon.png?platform=ios&hash=abc'],
    ['the photo library', 'ph://ED7AC36B-A150-4C38-BB8C-B6D696F4F2ED/L0/001'],
    ['inline data', 'data:image/png;base64,iVBORw0KGgo='],
  ])('never sends %s as a URL', (_label, uri) => {
    const r = render(h('RCTImageView', { frame: at(0, 0, 100, 100), source: [{ uri }] }));
    const json = JSON.stringify(serialise(read(r).elements, 2, SCREEN));
    expect(json).toContain('"tagName":"Image"');
    expect(json).not.toContain(uri.slice(0, 12));
  });

  it('sends no URL for an image below a view marked ar-mask', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844), testID: 'feed-item ar-mask' },
      h('RCTImageView', { frame: at(0, 0, 100, 100), source: [{ uri: PHOTO }] })));
    // Not captured in the first place, not merely dropped on the way out.
    expect(all(read(r)).find((e) => e.tag === 'Image')?.image?.src).toBeUndefined();
    const json = JSON.stringify(serialise(read(r).elements, 2, SCREEN));
    expect(json).not.toContain('babymind.baemtech.com');
    expect(json).toContain('"masked":true');
  });

  it('sends no image URLs at all when images are masked', () => {
    const r = render(h('RCTImageView', { frame: at(0, 0, 100, 100), source: [{ uri: PHOTO }] }));
    const json = JSON.stringify(serialise(read(r, new FiberIds(), { ...OPTIONS, maskImages: true }).elements, 2, SCREEN));
    expect(json).not.toContain('babymind.baemtech.com');
    expect(json).toContain('"masked":true');
  });

  it('refers to an app-bundled image by hash once it is known, and never reads a picked photo', () => {
    const asked: string[] = [];
    const bundled = 'http://localhost:8081/assets/assets/images/onboarding_baby_1.png?platform=ios&hash=1';
    const picked = 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/1.jpg';
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTImageView', { frame: at(0, 0, 100, 100), source: [{ uri: bundled }] }),
      h('RCTImageView', { frame: at(0, 100, 100, 100), source: [{ uri: picked }] })));
    const captured = read(r, new FiberIds(), {
      ...OPTIONS, assetFor: (uri) => { asked.push(uri); return 'f'.repeat(64); },
    });

    expect(asked).toEqual([bundled]);
    const json = JSON.stringify(serialise(captured.elements, 2, SCREEN));
    expect(json).toContain(`"asset":"${'f'.repeat(64)}"`);
    expect(json.match(/"asset"/g)).toHaveLength(1);
  });

  it('does not even look up the file of a masked image', () => {
    const asked: string[] = [];
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844), testID: 'ar-mask' },
      h('RCTImageView', { frame: at(0, 0, 100, 100), source: [{ uri: 'http://localhost:8081/assets/a.png' }] })));
    read(r, new FiberIds(), { ...OPTIONS, assetFor: (uri) => { asked.push(uri); return 'f'.repeat(64); } });
    expect(asked).toEqual([]);
  });

  it('records an icon as its glyph and font, not as a box and not as words', () => {
    const r = render(h('RCTText', {
      frame: at(0, 0, 24, 24), style: [{ fontFamily: 'ionicons', fontSize: 24 }, { color: '#A78BFA' }],
    }, '\uf4b5'));
    const [icon] = all(read(r)).filter((e) => e.tag === 'Icon');
    expect(icon?.icon).toEqual({ glyph: '\uf4b5', font: 'ionicons' });
    expect(icon?.style).toMatchObject({ color: '#A78BFA', fontSize: 24 });
    expect(texts(read(r))).toEqual([]);
  });

  it('records a gradient from the processed colours native receives', () => {
    const r = render(h('ViewManagerAdapter_ExpoLinearGradient', {
      frame: at(0, 0, 390, 120), colors: [0xffa78bfa, 0x80e9e3ff], locations: [0, 1],
      startPoint: [0, 0], endPoint: [1, 1],
    }));
    const [box] = all(read(r)).filter((e) => e.style?.gradient);
    expect(box?.style?.gradient).toBe('0,0,1,1|rgba(167,139,250,1)@0|rgba(233,227,255,0.502)@1');
  });
});

describe('what is not on screen', () => {
  it('skips a hidden Activity, display:none, and opacity 0', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h(React.Activity, { mode: 'hidden', children: h('RCTText', { frame: at(0, 0, 100, 20) }, 'arka plan') }),
      h('RCTView', { frame: at(0, 0, 100, 20), style: { display: 'none' } }, h('RCTText', { frame: at(0, 0, 100, 20) }, 'yok')),
      h('RCTView', { frame: at(0, 0, 100, 20), style: { opacity: 0 } }, h('RCTText', { frame: at(0, 0, 100, 20) }, 'saydam')),
      h('RCTText', { frame: at(0, 50, 100, 20) }, 'görünür')));

    expect(texts(read(r))).toEqual(['görünür']);
  });

  it('draws only the top card of a native stack, and a modal over it', () => {
    const card = (name: string, presentation?: string) => h('RNSScreen',
      { frame: at(0, 0, 390, 844), activityState: 2, stackPresentation: presentation },
      h('RCTText', { frame: at(0, 100, 200, 20) }, name));
    const r = render(h('RNSScreenStack', { frame: at(0, 0, 390, 844) },
      card('Liste', 'push'), card('Detay', 'push'), card('Paylaş', 'modal')));

    expect(texts(read(r))).toEqual(['Detay', 'Paylaş']);
  });

  it('skips an inactive tab screen', () => {
    const r = render(h('RNSScreenContainer', { frame: at(0, 0, 390, 844) },
      h('RNSScreen', { frame: at(0, 0, 390, 844), activityState: 0 }, h('RCTText', { frame: at(0, 0, 100, 20) }, 'Profil')),
      h('RNSScreen', { frame: at(0, 0, 390, 844), activityState: 2 }, h('RCTText', { frame: at(0, 0, 100, 20) }, 'Ana sayfa'))));

    expect(texts(read(r))).toEqual(['Ana sayfa']);
  });

  it('skips what is scrolled out of a scroll view or off the screen', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTScrollView', { frame: at(0, 100, 390, 300) },
        h('RCTScrollContentView', { frame: at(0, 100, 390, 2000) },
          h('RCTText', { frame: at(0, 120, 100, 20) }, 'üstte'),
          h('RCTText', { frame: at(0, 500, 100, 20) }, 'kaydırılmış'))),
      h('RCTText', { frame: at(0, 900, 100, 20) }, 'ekran dışı')));

    expect(texts(read(r))).toEqual(['üstte']);
  });
});

describe('masking on the real host names', () => {
  /**
   * iOS renders a TextInput as `RCTSinglelineTextInputView` or
   * `RCTMultilineTextInputView`. A table that only knew `TextInput` and
   * `AndroidTextInput` called these plain views, and the default mask — the
   * thing that keeps passwords off our servers — silently did not apply.
   */
  it.each(['RCTSinglelineTextInputView', 'RCTMultilineTextInputView', 'AndroidTextInput'])(
    'never lets the value of %s leave the device',
    (host) => {
      const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
        h(host, { frame: at(0, 0, 300, 44), text: 'hunter2', value: 'hunter2', placeholder: 'Şifre' })));

      const json = JSON.stringify(serialise(read(r).elements, read(r).rootId, SCREEN));
      expect(json).not.toContain('hunter2');
      expect(json).toContain('"tagName":"TextInput"');
      expect(json).toContain('"masked":true');
    },
  );

  it('masks a secure field even when inputs are recorded', () => {
    const r = render(h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: 'hunter2', secureTextEntry: true }));
    const json = JSON.stringify(serialise(read(r, new FiberIds(), { ...OPTIONS, maskAllInputs: false }).elements, 2, SCREEN));
    expect(json).not.toContain('hunter2');
  });

  it('records a field the customer chose to show', () => {
    const r = render(h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: 'İstanbul' }));
    const json = JSON.stringify(serialise(read(r, new FiberIds(), { ...OPTIONS, maskAllInputs: false }).elements, 2, SCREEN));
    expect(json).toContain('İstanbul');
  });

  it('masks every word below a view marked ar-mask', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844), testID: 'profile ar-mask' },
      h('RCTText', { frame: at(0, 0, 200, 20) }, 'Ayşe Yılmaz')));
    const json = JSON.stringify(serialise(read(r).elements, 2, SCREEN));
    expect(json).not.toContain('Ayşe');
  });
});

describe('the serialised result', () => {
  it('gives every node a unique id, text nodes included', () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      h('RCTText', { key: i, frame: at(0, (i % 40) * 20, 100, 20) }, `satır ${i}`));
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) }, rows));
    const captured = read(r);
    const tree = serialise(captured.elements, captured.rootId, SCREEN);

    const seen = new Set<number>();
    const walk = (node: { id: number; childNodes?: unknown[] }): void => {
      expect(seen.has(node.id)).toBe(false);
      seen.add(node.id);
      for (const child of (node.childNodes ?? []) as { id: number }[]) walk(child);
    };
    walk(tree);
    expect(seen.size).toBe(1 + 1 + 1200 * 2);
  });
});
