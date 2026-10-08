import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { captureTree, currentRootOf, FiberIds, type CaptureOptions, type Fiber } from '../src/fiber.js';
import { diff, serialise, tagFor, type CapturedElement, type Rect } from '../src/tree.js';

/**
 * The screen is read from React's committed fiber tree, so these tests render
 * with a real React and walk the fibers it really commits. The host component
 * names are React Native's own; the only thing faked is geometry, which each
 * host carries as a `frame` prop in window coordinates.
 */

const h = React.createElement;
const SCREEN = { width: 390, height: 844 };
/** The shipped defaults: what a person types is recorded, and the floor holds. */
const OPTIONS: Omit<CaptureOptions, 'measure'> = { screen: SCREEN, maskAllInputs: false, maskTestID: 'ar-mask' };
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
  /** Everything ingest would have received for this screen. */
  const wire = (r: ReactTestRenderer, options = OPTIONS): string => {
    const captured = read(r, new FiberIds(), options);
    return JSON.stringify(serialise(captured.elements, captured.rootId, SCREEN));
  };

  /**
   * iOS renders a TextInput as `RCTSinglelineTextInputView` or
   * `RCTMultilineTextInputView`. A table that only knew `TextInput` and
   * `AndroidTextInput` called these plain views, so neither the floor nor
   * `maskAllInputs` reached them at all.
   */
  it.each(['RCTSinglelineTextInputView', 'RCTMultilineTextInputView', 'AndroidTextInput'])(
    'never lets the value of a secure %s leave the device',
    (host) => {
      const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
        h(host, { frame: at(0, 0, 300, 44), text: 'hunter2', value: 'hunter2', secureTextEntry: true })));

      const json = wire(r);
      expect(json).not.toContain('hunter2');
      expect(json).toContain('"tagName":"TextInput"');
      expect(json).toContain('"masked":true');
    },
  );

  /**
   * The mobile default, and the reason the option exists: a replay of a form
   * nobody could finish is worth watching only if you can see what they were
   * trying to put in it. The same default as the browser SDK.
   */
  it('records what a person types, like the browser SDK', () => {
    const r = render(h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: 'İstanbul' }));
    expect(wire(r)).toContain('İstanbul');
  });

  it('masks every field when maskAllInputs is on', () => {
    const r = render(h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: 'İstanbul' }));
    expect(wire(r, { ...OPTIONS, maskAllInputs: true })).not.toContain('İstanbul');
  });

  /* -------------------------------------------------- the mobile floor -- */

  it.each([
    ['secureTextEntry', { secureTextEntry: true }],
    ['textContentType=password', { textContentType: 'password' }],
    ['textContentType=oneTimeCode', { textContentType: 'oneTimeCode' }],
    ['textContentType=creditCardNumber', { textContentType: 'creditCardNumber' }],
    ['autoComplete=cc-number', { autoComplete: 'cc-number' }],
    ['autoComplete=sms-otp', { autoComplete: 'sms-otp' }],
    ['keyboardType=visible-password', { keyboardType: 'visible-password' }],
    ['a placeholder that names the field', { placeholder: 'CVV' }],
    ['an accessibility label that does', { accessibilityLabel: 'Card number' }],
    ['a testID that does', { testID: 'checkout-cvc' }],
  ])('masks a field marked by %s, with inputs recorded', (_name, props) => {
    const r = render(h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: 'hunter2', ...props }));
    const json = wire(r);
    expect(json).not.toContain('hunter2');
    expect(json).toContain('"masked":true');
  });

  /**
   * The backstop for what a phone cannot tell us: a bare `<TextInput />` with
   * no hints, which on mobile is the common case rather than the exotic one.
   */
  it('masks a value shaped like a card number in a field with no hints at all', () => {
    const r = render(h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: '4242424242424242' }));
    expect(wire(r)).not.toContain('4242424242424242');
  });

  /**
   * The tree is read on a tick, and a tick can land while a card number is
   * still being typed — before it is long enough to pass the Luhn check. The
   * same keystrokes as the device test that found it on the web, each one a
   * tick, through the snapshot and through the mutations sent between ticks.
   */
  it('never lets more than six digits of a card number out while it is typed', () => {
    const card = '4242 4242 4242 4242';
    const Field = ({ text }: { text: string }) =>
      h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text, placeholder: 'Kart' });
    const r = render(h(Field, { text: '' }));
    const ids = new FiberIds();
    let before = serialise(read(r, ids).elements, 2, SCREEN);
    for (let n = 1; n <= card.length; n += 1) {
      const typed = card.slice(0, n);
      act(() => { r.update(h(Field, { text: typed })); });
      const after = serialise(read(r, ids).elements, 2, SCREEN);
      for (const json of [JSON.stringify(after), JSON.stringify(diff(before, after))]) {
        const leaked = (json.match(/[0-9][0-9 -]*[0-9]/g) ?? []).map((run) => run.replace(/[ -]/g, ''))
          .filter((run) => '4242424242424242'.startsWith(run) && run.length > 6);
        expect(leaked, typed).toEqual([]);
      }
      // Masked as any other field is: one mask, the placeholder kept.
      if (typed.replace(/ /g, '').length > 6) {
        expect(JSON.stringify(after), typed).toContain('"masked":true');
        expect(JSON.stringify(after), typed).toContain('"textContent":"••••••"');
        expect(JSON.stringify(after), typed).toContain('"placeholder":"Kart"');
      } else {
        expect(JSON.stringify(after), typed).toContain(`"textContent":"${typed}"`);
      }
      before = after;
    }
  });

  /**
   * A card number written inside longer text — a note, a message — is not a
   * card-shaped value, so the field stays recorded; only the number's digits
   * are starred, from its seventh, wherever it sits. Found with the web SDK on
   * an iOS simulator ("Hunter2Secret! card 5555555555554444" in a notes field).
   */
  it('never lets more than six digits of a card number inside a note out while it is typed', () => {
    const note = 'Kapıda öde.\nKartım 5555 5555 5555 4444, teşekkürler';
    const Field = ({ text }: { text: string }) =>
      h('RCTMultilineTextInputView', { frame: at(0, 0, 300, 120), text, multiline: true });
    const r = render(h(Field, { text: '' }));
    const ids = new FiberIds();
    let before = serialise(read(r, ids).elements, 2, SCREEN);
    for (let n = 1; n <= note.length; n += 1) {
      const typed = note.slice(0, n);
      act(() => { r.update(h(Field, { text: typed })); });
      const after = serialise(read(r, ids).elements, 2, SCREEN);
      for (const json of [JSON.stringify(after), JSON.stringify(diff(before, after))]) {
        const words = [...json.matchAll(/"(?:textContent|value)":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(' ');
        expect(words.replace(/[^0-9]/g, '').length, typed).toBeLessThanOrEqual(6);
      }
      // The field itself is not masked: the words around the number stay.
      expect(JSON.stringify(after), typed).not.toContain('"masked":true');
      before = after;
    }
    expect(JSON.stringify(before)).toContain('"textContent":"Kapıda öde.\\nKartım **** **** **** ****, teşekkürler"');
  });

  it('records telephone numbers, dates, post codes and quantities as typed', () => {
    for (const text of ['05321234567', '+90 532 123 45 67', '532 123 45 67', '415-555-0100', '2026-09-18', '34710', '3', '12345678']) {
      const r = render(h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text }));
      const json = wire(r);
      expect(json, text).toContain(`"textContent":"${text}"`);
      expect(json, text).not.toContain('"masked":true');
    }
  });

  /**
   * The honest limit, asserted so nobody can quietly widen it: a post code is
   * an address and an email is a contact detail, and masking either would take
   * the delivery step of a checkout replay with it.
   */
  it('records a post code and an email field: neither is a payment detail', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: '34710', textContentType: 'postalCode' }),
      h('RCTSinglelineTextInputView', {
        frame: at(0, 50, 300, 44), text: 'ada@example.com', textContentType: 'emailAddress',
      })));
    const json = wire(r);
    expect(json).toContain('34710');
    expect(json).toContain('ada@example.com');
  });

  /**
   * The mobile half of `maskAllTyping`. There is no `contenteditable` here, so
   * what the option adds is that it cannot be weakened: an app that sets it
   * does not get field values back because `maskAllInputs: false` is also set
   * somewhere else in its configuration.
   */
  it('masks every field when maskAllTyping is on, whatever maskAllInputs says', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTSinglelineTextInputView', { frame: at(0, 0, 300, 44), text: 'İstanbul', placeholder: 'Şehir' }),
      h('RCTMultilineTextInputView', { frame: at(0, 50, 300, 90), value: 'Kapıda ödeme olsun' })));

    const options = { ...OPTIONS, maskAllInputs: false, maskAllTyping: true };
    const json = JSON.stringify(serialise(read(r, new FiberIds(), options).elements, 2, SCREEN));
    expect(json).not.toContain('İstanbul');
    expect(json).not.toContain('Kapıda ödeme olsun');
    // The placeholder is the app's own copy, never something a person typed, so
    // a masked form still reads as a form rather than a column of grey boxes.
    expect(json).toContain('Şehir');
  });

  it('leaves text that was not typed alone when maskAllTyping is on', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTText', { frame: at(0, 0, 200, 20) }, 'Sepetiniz')));
    const options = { ...OPTIONS, maskAllTyping: true };
    expect(JSON.stringify(serialise(read(r, new FiberIds(), options).elements, 2, SCREEN))).toContain('Sepetiniz');
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

describe('what a control says about itself', () => {
  const byText = (captured: ReturnType<typeof read>, text: string) => all(captured).find((e) => e.text === text);

  it('passes the accessibility role through, in the format’s words', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTText', { frame: at(0, 0, 200, 30), accessibilityRole: 'header' }, 'Hesap'),
      h('RCTText', { frame: at(0, 40, 200, 20), role: 'link' }, 'Gizlilik'),
      h('RCTView', { frame: at(0, 70, 100, 40), role: 'tab', accessibilityState: { selected: true } },
        h('RCTText', { frame: at(10, 80, 80, 20) }, 'Siparişler')),
      h('RCTView', { frame: at(0, 120, 100, 40), accessibilityRole: 'imagebutton' }),
      h('RCTText', { frame: at(0, 170, 200, 20), accessibilityRole: 'summary' }, 'Özet')));
    const captured = read(r);
    expect(byText(captured, 'Hesap')?.role).toBe('header');
    expect(byText(captured, 'Gizlilik')?.role).toBe('link');
    const tab = all(captured).find((e) => e.role === 'tab');
    expect(tab).toMatchObject({ on: true });
    expect(all(captured).find((e) => e.role === 'button')?.tag).toBe('Pressable');
    // Not one of the format's roles: dropped rather than guessed at.
    expect(byText(captured, 'Özet')?.role).toBeUndefined();
  });

  it('records a disabled button, and a field that cannot be edited', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTView', { frame: at(0, 0, 200, 44), accessibilityRole: 'button', accessibilityState: { disabled: true } },
        h('RCTText', { frame: at(10, 10, 100, 20) }, 'Öde')),
      h('RCTSinglelineTextInputView', { frame: at(0, 60, 200, 44), editable: false, value: 'TR12' })));
    const captured = all(read(r));
    expect(captured.find((e) => e.tag === 'Pressable')?.disabled).toBe(true);
    expect(captured.find((e) => e.tag === 'TextInput')?.disabled).toBe(true);
  });

  it('records a switch, a checkbox and a mixed checkbox as on, off and mixed', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTSwitch', { frame: at(0, 0, 51, 31), value: true }),
      h('RNCCheckbox', { frame: at(0, 40, 24, 24), value: false }),
      h('RCTView', { frame: at(0, 80, 24, 24), accessibilityRole: 'checkbox', accessibilityState: { checked: 'mixed' } }),
      h('RCTView', { frame: at(40, 80, 24, 24), role: 'radio', 'aria-checked': true })));
    const captured = all(read(r));
    expect(captured.find((e) => e.tag === 'Switch')?.on).toBe(true);
    expect(captured.filter((e) => e.tag === 'Checkbox').map((e) => [e.on, e.role])).toEqual([
      [false, undefined], ['mixed', undefined], [true, 'radio'],
    ]);
  });

  /** A reader fills a checked Checkbox; a whole settings row filled with the accent colour is not what was on screen. */
  it('keeps a row that says it is a checkbox a row, with its state and its words', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTView', { frame: at(0, 0, 390, 56), accessibilityRole: 'checkbox', accessibilityState: { checked: true }, accessible: true, onClick: () => {} },
        h('RCTText', { frame: at(16, 18, 200, 20) }, 'Bildirimler'))));
    const row = all(read(r)).find((e) => e.on !== undefined);
    expect(row?.tag).toBe('Pressable');
    expect(row?.on).toBe(true);
    expect(texts(read(r))).toContain('Bildirimler');
  });
});

describe('how text is set', () => {
  const style = (s: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTText', { frame: at(0, 0, 300, 20), style: s, ...extra }, 'Metin')));
    return all(read(r)).find((e) => e.text === 'Metin')!.style ?? {};
  };

  it('reads the weight in every form React Native takes it', () => {
    expect(style({ fontWeight: 'bold' }).fontWeight).toBe(700);
    expect(style({ fontWeight: '600' }).fontWeight).toBe(600);
    expect(style({ fontWeight: 650 }).fontWeight).toBe(700);
    expect(style({ fontWeight: 'semibold' }).fontWeight).toBe(600);
    // A custom family is one family per weight, with no fontWeight at all.
    expect(style({ fontFamily: 'Inter-SemiBold' }).fontWeight).toBe(600);
    expect(style({ fontFamily: 'Poppins-ExtraBold' }).fontWeight).toBe(800);
    expect(style({ fontFamily: 'Inter-Regular' }).fontWeight).toBeUndefined();
  });

  it('hints at the kind of typeface, never its name', () => {
    expect(style({ fontFamily: 'Menlo' }).fontHint).toBe('mono');
    expect(style({ fontFamily: 'SpaceMono-Regular' }).fontHint).toBe('mono');
    expect(style({ fontFamily: 'Georgia' }).fontHint).toBe('serif');
    expect(style({ fontFamily: 'SF Pro Rounded' }).fontHint).toBe('rounded');
    expect(style({ fontFamily: 'sans-serif' }).fontHint).toBe('system');
    expect(style({ fontFamily: 'OpenSans-Regular' }).fontHint).toBeUndefined();
    expect(style({ fontFamily: 'Inter' }).fontHint).toBeUndefined();
  });

  it('reads italics and alignment', () => {
    expect(style({ fontStyle: 'italic', textAlign: 'center' })).toMatchObject({ italic: true, align: 'center' });
    expect(style({ textAlign: 'auto' }).align).toBeUndefined();
  });

  it('counts the lines a text wrapped to, up to numberOfLines', () => {
    const lines = (height: number, s: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
        h('RCTText', { frame: at(0, 0, 300, height), style: s, ...extra }, 'Uzun bir paragraf')));
      return all(read(r)).find((e) => e.text)!.style?.lines;
    };
    expect(lines(17, { fontSize: 14 })).toBeUndefined();
    expect(lines(51, { fontSize: 14 })).toBe(3);
    expect(lines(60, { fontSize: 14, lineHeight: 20 })).toBe(3);
    expect(lines(60, { fontSize: 14, lineHeight: 20 }, { numberOfLines: 2 })).toBe(2);
  });

  it('leaves the glyph of an icon font without text styling', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTText', { frame: at(0, 0, 24, 24), style: { fontFamily: 'Ionicons', fontWeight: 'bold', textAlign: 'center' } }, '\uf4b5')));
    const icon = all(read(r)).find((e) => e.tag === 'Icon')!;
    expect(icon.style?.fontWeight).toBeUndefined();
    expect(icon.style?.align).toBeUndefined();
  });
});

describe('opacity and layers', () => {
  it('hands an unrecorded wrapper’s opacity to what is inside it, multiplied', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTView', { frame: at(0, 0, 200, 100), style: { opacity: 0.5 } },
        h('RCTView', { frame: at(0, 0, 200, 50), style: { backgroundColor: '#eee', opacity: 0.5 } },
          h('RCTText', { frame: at(0, 0, 100, 20) }, 'Soluk')))));
    const captured = all(read(r));
    expect(captured.find((e) => e.style?.backgroundColor)?.style?.opacity).toBe(0.25);
    // Opacity multiplies down the recorded tree on its own.
    expect(captured.find((e) => e.text === 'Soluk')?.style?.opacity).toBeUndefined();
  });

  it('records zIndex as a layer', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTView', { frame: at(0, 0, 200, 100), style: { backgroundColor: '#eee', zIndex: 5 } })));
    expect(all(read(r)).find((e) => e.style?.backgroundColor)?.style?.zIndex).toBe(5);
  });

  it('hangs a modal from the screen, wherever React rendered it', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTView', { frame: at(0, 100, 390, 400), style: { backgroundColor: '#fafafa' } },
        h('RCTModalHostView', { frame: at(0, 100, 390, 400), transparent: true },
          h('RCTView', { frame: at(20, 300, 350, 200), style: { backgroundColor: '#ffffff' } },
            h('RCTText', { frame: at(40, 320, 200, 20) }, 'Emin misiniz?'))))));
    const captured = read(r);
    expect(captured.layers).toHaveLength(1);
    const node = serialise(captured.elements, captured.rootId, SCREEN, captured.layers);
    const modal = node.childNodes!.find((c) => c.tagName === 'Modal')!;
    expect(modal.attributes).toMatchObject({ x: 0, y: 0, w: 390, h: 844 });
    // Positions inside it are relative to the screen it covers.
    expect(modal.childNodes![0]!.attributes).toMatchObject({ x: 20, y: 300 });
  });
});

describe('scroll views', () => {
  it('records the scroll offset and places the content in content coordinates', () => {
    // Scrolled 300 pt down: the content container starts 300 pt above the scroll view.
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTScrollView', { frame: at(0, 100, 390, 400) },
        h('RCTScrollContentView', { frame: at(0, -200, 390, 2000) },
          h('RCTText', { frame: at(16, 420, 200, 20) }, 'Satır 31')))));
    const captured = all(read(r));
    const scroll = captured.find((e) => e.tag === 'ScrollView')!;
    expect(scroll.scroll).toEqual({ x: 0, y: 300 });
    // 620 pt down the content, wherever the list has scrolled to.
    expect(captured.find((e) => e.text === 'Satır 31')!.rect).toMatchObject({ x: 16, y: 620 });
  });

  it('records a horizontal list the same way', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('AndroidHorizontalScrollView', { frame: at(0, 100, 390, 120) },
        h('AndroidHorizontalScrollContentView', { frame: at(-500, 100, 2000, 120) },
          h('RCTText', { frame: at(10, 150, 100, 20) }, 'Kart 6')))));
    const captured = all(read(r));
    expect(captured.find((e) => e.tag === 'ScrollView')!.scroll).toEqual({ x: 500, y: 0 });
    expect(captured.find((e) => e.text === 'Kart 6')!.rect).toMatchObject({ x: 510, y: 50 });
  });

  it('sends sx and sy on every scroll view, 0 included', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTScrollView', { frame: at(0, 100, 390, 400) }, h('RCTText', { frame: at(0, 120, 100, 20) }, 'üstte'))));
    const captured = read(r);
    const node = serialise(captured.elements, captured.rootId, SCREEN);
    const find = (n: typeof node): typeof node | undefined =>
      n.tagName === 'ScrollView' ? n : (n.childNodes ?? []).map(find).find(Boolean);
    expect(find(node)!.attributes).toMatchObject({ sx: 0, sy: 0 });
  });
});

describe('the newer tags', () => {
  it('records a slider’s value and range', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RNCSlider', { frame: at(0, 0, 300, 40), value: 0.333333, minimumValue: 0, maximumValue: 1, accessibilityLabel: 'Ses' })));
    const slider = all(read(r)).find((e) => e.tag === 'Slider')!;
    expect(slider.range).toEqual({ val: 0.333, min: 0, max: 1 });
    expect(slider.labels).toEqual({ 'aria-label': 'Ses' });
  });

  it('records a spinner as indeterminate progress, and a stopped one not at all', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RCTActivityIndicatorView', { frame: at(0, 0, 20, 20), animating: true }),
      h('RCTActivityIndicatorView', { frame: at(0, 40, 20, 20), animating: false }),
      h('AndroidProgressBar', { frame: at(0, 80, 300, 4), indeterminate: false, progress: 0.4, styleAttr: 'Horizontal' })));
    const progress = all(read(r)).filter((e) => e.tag === 'Progress');
    expect(progress.map((p) => p.range)).toEqual([{}, { val: 0.4, min: 0, max: 1 }]);
  });

  it('never looks inside a web view, a map or a video', () => {
    const r = render(h('RCTView', { frame: at(0, 0, 390, 844) },
      h('RNCWebView', { frame: at(0, 0, 390, 300), source: { uri: 'https://example.com/account?token=abc' }, accessibilityLabel: 'Yardım' },
        h('RCTText', { frame: at(0, 0, 100, 20) }, 'gizli')),
      h('AIRMap', { frame: at(0, 300, 390, 200) },
        h('AIRMapMarker', { frame: at(100, 400, 30, 30) }, h('RCTText', { frame: at(100, 400, 30, 20) }, 'Ev'))),
      h('RCTVideo', { frame: at(0, 500, 390, 200), source: { uri: 'https://cdn.example.com/a.mp4' } })));
    const captured = read(r);
    expect(all(captured).filter((e) => ['WebView', 'Map', 'Video'].includes(e.tag)).map((e) => e.tag)).toEqual(['WebView', 'Map', 'Video']);
    expect(texts(captured)).toEqual([]);
    const wire = JSON.stringify(serialise(captured.elements, captured.rootId, SCREEN));
    expect(wire).not.toContain('example.com');
    expect(wire).toContain('Yardım');
  });

  it.each([
    ['RNCWebView', 'WebView'], ['AIRMap', 'Map'], ['AIRGoogleMap', 'Map'], ['RNMapsMapView', 'Map'],
    ['RNMBXMapView', 'Map'], ['RCTVideo', 'Video'], ['ExpoVideoView', 'Video'], ['RNCSlider', 'Slider'],
    ['RNCCheckbox', 'Checkbox'], ['AndroidCheckBox', 'Checkbox'], ['RCTModalHostView', 'Modal'],
    ['RCTActivityIndicatorView', 'Progress'], ['AndroidProgressBar', 'Progress'], ['RNCProgressView', 'Progress'],
    ['AndroidHorizontalScrollView', 'ScrollView'], ['RCTScrollContentView', 'View'],
  ])('knows %s as %s', (name, tag) => {
    expect(tagFor(name)).toBe(tag);
  });
});

describe('a change undone', () => {
  it('sends the neutral value for a key that went away', () => {
    const before = serialise(new Map([[2, { id: 2, tag: 'Pressable', rect: at(0, 0, 100, 40), disabled: true, style: { backgroundColor: '#eee', opacity: 0.5 }, children: [] } as CapturedElement]]), 2, SCREEN);
    const after = serialise(new Map([[2, { id: 2, tag: 'Pressable', rect: at(0, 0, 100, 40), children: [] } as CapturedElement]]), 2, SCREEN);
    expect(diff(before, after).attributes).toEqual([{ id: 2, attributes: { disabled: false, op: 1, bg: 'transparent' } }]);
  });
});
