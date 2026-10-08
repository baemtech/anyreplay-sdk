import { describe, expect, it } from 'vitest';
import { NODE } from '../src/wire.js';
import { diff, isEmpty, serialise, tagFor, type CapturedElement } from '../src/tree.js';

const el = (over: Partial<CapturedElement> & { id: number }): CapturedElement => ({
  tag: 'View', rect: { x: 0, y: 0, width: 100, height: 20 }, children: [], ...over,
});

const registry = (...items: CapturedElement[]): Map<number, CapturedElement> =>
  new Map(items.map((item) => [item.id, item]));

const SCREEN = { width: 390, height: 844 };

describe('tagFor', () => {
  it.each([
    ['View', 'View'], ['RCTView', 'View'], ['SafeAreaView', 'View'],
    ['Text', 'Text'], ['RCTVirtualText', 'Text'],
    ['TextInput', 'TextInput'], ['AndroidTextInput', 'TextInput'],
    ['RCTSinglelineTextInputView', 'TextInput'], ['RCTMultilineTextInputView', 'TextInput'],
    ['RCTImageView', 'Image'], ['ExpoImage', 'Image'], ['AndroidSwitch', 'Switch'],
    ['TouchableOpacity', 'Pressable'], ['FlatList', 'ScrollView'],
  ])('maps %s to %s', (name, expected) => {
    expect(tagFor(name)).toBe(expected);
  });

  it('does not guess at something it has never seen', () => {
    expect(tagFor('LottieAnimation')).toBe('Unknown');
  });
});

describe('pictures and decoration on the wire', () => {
  it('sends an image URL, its fit, corners, border and gradient under short names', () => {
    const tree = serialise(registry(el({
      id: 2, tag: 'Image', image: { src: 'https://cdn.example.com/a.jpg', fit: 'cover' },
      style: { radius: 12.34, borderWidth: 1, borderColor: '#ddd', gradient: '0,0,1,1|#fff|#000' },
    })), 2, SCREEN);
    expect(tree.childNodes![0]!.attributes).toMatchObject({
      src: 'https://cdn.example.com/a.jpg', fit: 'cover', r: 12.3, bw: 1, bc: '#ddd', grad: '0,0,1,1|#fff|#000',
    });
  });

  it('drops the URL of a masked image even if one was captured', () => {
    const tree = serialise(registry(el({
      id: 2, tag: 'Image', image: { src: 'https://cdn.example.com/a.jpg' }, masked: true,
    })), 2, SCREEN);
    expect(JSON.stringify(tree)).not.toContain('cdn.example.com');
  });

  it('drops the hash of a masked app image even if one was captured', () => {
    const tree = serialise(registry(el({
      id: 2, tag: 'Image', image: { asset: 'f'.repeat(64) }, masked: true,
    })), 2, SCREEN);
    expect(JSON.stringify(tree)).not.toContain('f'.repeat(64));
  });

  it('sends an icon as its glyph and font', () => {
    const tree = serialise(registry(el({ id: 2, tag: 'Icon', icon: { glyph: '\uf4b5', font: 'ionicons' } })), 2, SCREEN);
    expect(tree.childNodes![0]!.attributes).toMatchObject({ glyph: '\uf4b5', font: 'ionicons' });
    expect(tree.childNodes![0]!.childNodes).toEqual([]);
  });
});

describe('serialise', () => {
  it('produces the node shape the server already knows how to read', () => {
    const tree = serialise(registry(el({ id: 2, tag: 'Text', text: 'Kaydet' })), 2, SCREEN);
    const text = tree.childNodes![0]!;

    expect(text.type).toBe(NODE.element);
    expect(text.tagName).toBe('Text');
    // A Text becomes an element with a text child, exactly as a <span> would —
    // which is what makes the server's existing extractor find the words.
    expect(text.childNodes![0]!.type).toBe(NODE.text);
    expect(text.childNodes![0]!.textContent).toBe('Kaydet');
  });

  it('carries layout as plain numbers, rounded', () => {
    const tree = serialise(
      registry(el({ id: 2, rect: { x: 10.4, y: 20.6, width: 100.2, height: 44.8 } })), 2, SCREEN,
    );
    expect(tree.childNodes![0]!.attributes).toMatchObject({ x: 10, y: 21, w: 100, h: 45 });
  });

  /**
   * A box drawn in the wrong place is worse than a missing one: a reviewer
   * cannot tell it from the truth.
   */
  it('drops an element whose layout never arrived rather than guessing', () => {
    const tree = serialise(registry(el({ id: 2, rect: undefined })), 2, SCREEN);
    expect(tree.childNodes).toHaveLength(0);
  });

  it('drops a zero-sized element, which is not on screen', () => {
    const tree = serialise(
      registry(el({ id: 2, rect: { x: 0, y: 0, width: 0, height: 0 } })), 2, SCREEN,
    );
    expect(tree.childNodes).toHaveLength(0);
  });

  it('keeps the box of a masked field and loses only its words', () => {
    const tree = serialise(
      registry(el({ id: 2, tag: 'TextInput', text: 'hunter2', masked: true })), 2, SCREEN,
    );
    const input = tree.childNodes![0]!;

    expect(input.attributes).toMatchObject({ masked: true, w: 100, h: 20 });
    expect(JSON.stringify(input)).not.toContain('hunter2');
  });

  it('keeps the placeholder of a masked field, which is the app’s copy and not the person’s input', () => {
    // Same rule as the web recorder. A masked form without placeholders replays
    // as identical striped boxes, and the value itself still never travels.
    const tree = serialise(
      registry(el({ id: 2, tag: 'TextInput', text: '4111 1111 1111 1111', labels: { placeholder: 'Kart numarası' }, masked: true })),
      2, SCREEN,
    );
    expect(tree.childNodes![0]!.attributes).toMatchObject({ placeholder: 'Kart numarası', masked: true });
    expect(JSON.stringify(tree)).not.toContain('4111');
  });

  it('masks the accessibility label of a masked element, which can describe its value', () => {
    const tree = serialise(
      registry(el({ id: 2, tag: 'Text', text: 'Ayşe Yılmaz', labels: { 'aria-label': 'Ayşe Yılmaz' }, masked: true })),
      2, SCREEN,
    );
    expect(JSON.stringify(tree)).not.toContain('Ayşe');
  });

  it('keeps an unmasked placeholder, which is prose worth translating', () => {
    const tree = serialise(
      registry(el({ id: 2, tag: 'Text', labels: { placeholder: 'Ara' } })), 2, SCREEN,
    );
    expect(tree.childNodes![0]!.attributes).toMatchObject({ placeholder: 'Ara' });
  });

  it('nests children under their parent', () => {
    const tree = serialise(registry(
      el({ id: 2, children: [3] }),
      el({ id: 3, tag: 'Text', text: 'İptal' }),
    ), 2, SCREEN);

    expect(tree.childNodes![0]!.childNodes![0]!.tagName).toBe('Text');
  });
});

describe('diff', () => {
  const treeOf = (...items: CapturedElement[]) => serialise(registry(...items), 2, SCREEN);

  it('reports nothing when nothing moved', () => {
    const before = treeOf(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    expect(isEmpty(diff(before, treeOf(el({ id: 2, tag: 'Text', text: 'Merhaba' }))))).toBe(true);
  });

  /**
   * The lever the whole cost story rests on. A phone re-renders constantly and
   * almost nothing moves; sending only what did is the difference between
   * kilobytes and megabytes per session.
   */
  it('reports only the attribute that changed, not the whole node', () => {
    const before = treeOf(el({ id: 2 }));
    const after = treeOf(el({ id: 2, rect: { x: 0, y: 40, width: 100, height: 20 } }));

    const mutation = diff(before, after);
    expect(mutation.attributes).toEqual([{ id: 2, attributes: { y: 40 } }]);
    expect(mutation.adds).toHaveLength(0);
  });

  it('reports changed text as text, not as a replaced node', () => {
    const before = treeOf(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const after = treeOf(el({ id: 2, tag: 'Text', text: 'Görüşürüz' }));

    const mutation = diff(before, after);
    expect(mutation.texts).toEqual([{ id: 3, value: 'Görüşürüz' }]);
    expect(mutation.adds).toHaveLength(0);
  });

  it('sends an added subtree once, at its root', () => {
    const before = treeOf(el({ id: 2 }));
    const after = treeOf(
      el({ id: 2, children: [3] }),
      el({ id: 3, children: [4] }),
      el({ id: 4, tag: 'Text', text: 'yeni' }),
    );

    const mutation = diff(before, after);
    expect(mutation.adds).toHaveLength(1);
    expect(mutation.adds[0]!.parentId).toBe(2);
    // The grandchild rides along inside its parent rather than being repeated.
    expect(JSON.stringify(mutation.adds[0]!.node)).toContain('yeni');
  });

  it('sends a removed subtree once, at its root', () => {
    const before = treeOf(
      el({ id: 2, children: [3] }),
      el({ id: 3, children: [4] }),
      el({ id: 4, tag: 'Text', text: 'giden' }),
    );
    const after = treeOf(el({ id: 2 }));

    expect(diff(before, after).removes).toEqual([{ id: 3 }]);
  });
});
