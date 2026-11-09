import { describe, expect, it } from 'vitest';
import { NODE, type MobileNode } from '../src/wire.js';
import { diff, isEmpty, serialise, tagFor, type CapturedElement, type Mutation } from '../src/tree.js';

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

/**
 * A reader, as MOBILE-REPLAY-FORMAT §2.2 describes one: removes, then adds
 * (appended as the parent's last child), then attributes, then texts. No
 * "move" repair: a diff has to stand on its own.
 */
function apply(tree: MobileNode, mutation: Mutation): MobileNode {
  const root = structuredClone(tree);
  const find = (node: MobileNode, id: number, parent: MobileNode | null): [MobileNode, MobileNode | null] | null => {
    if (node.id === id) return [node, parent];
    for (const child of node.childNodes ?? []) {
      const hit = find(child, id, node);
      if (hit) return hit;
    }
    return null;
  };
  const ids = (node: MobileNode, into: number[] = []): number[] => {
    into.push(node.id);
    for (const child of node.childNodes ?? []) ids(child, into);
    return into;
  };
  for (const { id } of mutation.removes) {
    const [node, parent] = find(root, id, null) ?? (() => { throw new Error(`remove of missing ${id}`); })();
    parent!.childNodes = parent!.childNodes!.filter((child) => child !== node);
  }
  for (const { parentId, node } of mutation.adds) {
    for (const id of ids(node)) if (find(root, id, null)) throw new Error(`add of ${id}, already in the tree`);
    const [parent] = find(root, parentId, null) ?? (() => { throw new Error(`add under missing ${parentId}`); })();
    parent.childNodes = [...(parent.childNodes ?? []), structuredClone(node)];
  }
  for (const { id, attributes } of mutation.attributes) {
    const [node] = find(root, id, null)!;
    node.attributes = { ...node.attributes, ...attributes };
  }
  for (const { id, value } of mutation.texts) find(root, id, null)![0].textContent = value;
  return root;
}

/** What a reader ends up with, with keys a neutral value stands for left out. */
function drawn(node: MobileNode): unknown {
  const attributes = Object.fromEntries(Object.entries(node.attributes ?? {}).filter(([key, value]) => !(
    (key === 'disabled' || key === 'masked' || key === 'it' || key === 'on') && value === false
  )));
  return node.type === NODE.text
    ? { id: node.id, text: node.textContent }
    : { id: node.id, tag: node.tagName, attributes, children: (node.childNodes ?? []).map(drawn) };
}

describe('diff, read back by a reader that only appends', () => {
  const treeOf = (...items: CapturedElement[]) => serialise(registry(...items), 2, SCREEN);
  const row = (id: number, y: number, text?: string) => el({ id, rect: { x: 0, y, width: 100, height: 20 }, ...(text ? { tag: 'Text' as const, text } : {}) });

  function roundTrip(before: MobileNode, after: MobileNode): Mutation {
    const mutation = diff(before, after);
    // `apply` throws where the checker would raise MUT-001 or MUT-002
    // (test/conformance.test.ts runs the checker itself on moves).
    expect(drawn(apply(before, mutation))).toEqual(drawn(after));
    return mutation;
  }

  it('moves a view to another parent that was already there: removed, then added there', () => {
    const before = treeOf(
      el({ id: 2, children: [4, 8] }),
      el({ id: 4, children: [6] }), row(6, 0, 'Sepet'),
      el({ id: 8 }),
    );
    const after = treeOf(
      el({ id: 2, children: [4, 8] }),
      el({ id: 4 }),
      el({ id: 8, children: [6] }), row(6, 0, 'Sepet'),
    );
    const mutation = roundTrip(before, after);
    expect(mutation.removes).toEqual([{ id: 6 }]);
    expect(mutation.adds.map((add) => [add.parentId, add.node.id])).toEqual([[8, 6]]);
  });

  it('moves a view under a wrapper that just appeared: its old copy is removed', () => {
    const before = treeOf(el({ id: 2, children: [6] }), row(6, 0, 'Kaydet'));
    const after = treeOf(el({ id: 2, children: [4] }), el({ id: 4, children: [6] }), row(6, 0, 'Kaydet'));
    const mutation = roundTrip(before, after);
    expect(mutation.removes).toEqual([{ id: 6 }]);
    expect(mutation.adds.map((add) => [add.parentId, add.node.id])).toEqual([[2, 4]]);
  });

  it('reorders siblings: the ones out of place are sent again, in order', () => {
    const before = treeOf(el({ id: 2, children: [4, 6, 8] }), row(4, 0, 'a'), row(6, 20, 'b'), row(8, 40, 'c'));
    const after = treeOf(el({ id: 2, children: [4, 8, 6] }), row(4, 0, 'a'), row(8, 40, 'c'), row(6, 20, 'b'));
    const mutation = roundTrip(before, after);
    expect(mutation.removes).toEqual([{ id: 6 }]);
    expect(mutation.adds.map((add) => add.node.id)).toEqual([6]);
  });

  it('puts a view inserted between two others between them, not at the end', () => {
    const before = treeOf(el({ id: 2, children: [4, 8] }), row(4, 0, 'a'), row(8, 40, 'c'));
    const after = treeOf(el({ id: 2, children: [4, 6, 8] }), row(4, 0, 'a'), row(6, 20, 'b'), row(8, 40, 'c'));
    const mutation = roundTrip(before, after);
    expect(mutation.adds.map((add) => add.node.id)).toEqual([6, 8]);
  });

  it('still sends nothing again for a view appended at the end or one taken from the middle', () => {
    const before = treeOf(el({ id: 2, children: [4, 6, 8] }), row(4, 0, 'a'), row(6, 20, 'b'), row(8, 40, 'c'));
    const after = treeOf(el({ id: 2, children: [4, 8, 10] }), row(4, 0, 'a'), row(8, 40, 'c'), row(10, 60, 'd'));
    const mutation = roundTrip(before, after);
    expect(mutation.removes).toEqual([{ id: 6 }]);
    expect(mutation.adds.map((add) => add.node.id)).toEqual([10]);
  });

  it('keeps a text node first when an element with children gains its text', () => {
    const before = treeOf(el({ id: 2, children: [4] }), el({ id: 4, tag: 'Pressable', children: [6] }), el({ id: 6 }));
    const after = treeOf(el({ id: 2, children: [4] }), el({ id: 4, tag: 'Pressable', text: 'Tamam', children: [6] }), el({ id: 6 }));
    roundTrip(before, after);
  });

  it('replaces a node that came back as another tag under the same id', () => {
    const before = treeOf(el({ id: 2, children: [4] }), el({ id: 4, tag: 'View' }));
    const after = treeOf(el({ id: 2, children: [4] }), el({ id: 4, tag: 'Image' }));
    const mutation = roundTrip(before, after);
    expect(mutation.removes).toEqual([{ id: 4 }]);
    expect(mutation.adds[0]!.node.tagName).toBe('Image');
  });

  it('turns any tree into any other, across a thousand random edits', () => {
    let seed = 42;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    let nextId = 4;
    // A registry of ids to child lists; 2 is the top-level view.
    let shape = new Map<number, number[]>([[2, []]]);
    const texts = new Map<number, string>();
    const build = (): MobileNode => treeOf(...[...shape].map(([id, children], i) => el({
      id, children, rect: { x: 0, y: i, width: 50, height: 10 }, ...(texts.has(id) ? { tag: 'Text' as const, text: texts.get(id)! } : {}),
    })));
    const descendants = (of: Map<number, number[]>, id: number, into = new Set<number>()): Set<number> => {
      into.add(id);
      for (const child of of.get(id)!) descendants(of, child, into);
      return into;
    };
    let before = build();
    for (let step = 0; step < 1000; step += 1) {
      const next = new Map([...shape].map(([id, children]) => [id, [...children]]));
      const parentOf = (id: number): number | undefined => [...next].find(([, children]) => children.includes(id))?.[0];
      for (let edits = 1 + random(3); edits > 0; edits -= 1) {
        const all = [...next.keys()];
        const pick = all[random(all.length)]!;
        switch (random(5)) {
          case 0: { // add
            const id = nextId; nextId += 2;
            next.set(id, []);
            const siblings = next.get(pick)!;
            siblings.splice(random(siblings.length + 1), 0, id);
            break;
          }
          case 1: { // remove
            const parent = parentOf(pick);
            if (parent === undefined) break;
            next.set(parent, next.get(parent)!.filter((c) => c !== pick));
            for (const id of descendants(next, pick)) next.delete(id);
            break;
          }
          case 2: { // move somewhere that is not inside itself
            const parent = parentOf(pick);
            if (parent === undefined) break;
            const inside = descendants(next, pick);
            const targets = [...next.keys()].filter((id) => !inside.has(id));
            const target = targets[random(targets.length)]!;
            next.set(parent, next.get(parent)!.filter((c) => c !== pick));
            const siblings = next.get(target)!;
            siblings.splice(random(siblings.length + 1), 0, pick);
            break;
          }
          case 3: // text
            if (random(2)) texts.set(pick, `t${step}`); else texts.delete(pick);
            break;
          default: { // wrap
            const parent = parentOf(pick);
            if (parent === undefined) break;
            const id = nextId; nextId += 2;
            next.set(id, [pick]);
            next.set(parent, next.get(parent)!.map((c) => (c === pick ? id : c)));
          }
        }
      }
      shape = next;
      for (const id of texts.keys()) if (!shape.has(id)) texts.delete(id);
      const after = build();
      roundTrip(before, after);
      before = after;
    }
    expect(shape.size).toBeGreaterThan(5);
  });
});
