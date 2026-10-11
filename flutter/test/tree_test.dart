import 'dart:convert';

import 'package:anyreplay_flutter/src/tree.dart';
import 'package:flutter_test/flutter_test.dart';

MobileNode screen(List<MobileNode> children) =>
    MobileNode.element(1, 'Screen', {'x': 0, 'y': 0, 'w': 390, 'h': 844})..children.addAll(children);

MobileNode el(int id, String tag,
    {Map<String, Object> attrs = const {}, String? text, List<MobileNode> children = const []}) {
  final node = MobileNode.element(id, tag, {'x': 0, 'y': 0, 'w': 10, 'h': 10, ...attrs});
  if (text != null) node.children.add(MobileNode.text(id + 1, text));
  node.children.addAll(children);
  return node;
}

Map<String, Object?> json(Mutation m) => jsonDecode(jsonEncode(m.toJson())) as Map<String, Object?>;

void main() {
  test('serialises to rrweb node shapes', () {
    final tree = screen([el(2, 'Text', text: 'Merhaba')]);
    expect(jsonDecode(jsonEncode(tree.toJson())), {
      'type': 2,
      'id': 1,
      'tagName': 'Screen',
      'attributes': {'x': 0, 'y': 0, 'w': 390, 'h': 844},
      'childNodes': [
        {
          'type': 2,
          'id': 2,
          'tagName': 'Text',
          'attributes': {'x': 0, 'y': 0, 'w': 10, 'h': 10},
          'childNodes': [
            {'type': 3, 'id': 3, 'textContent': 'Merhaba'}
          ]
        },
      ],
    });
  });

  test('nothing changed is an empty mutation', () {
    expect(diffTrees(screen([el(2, 'View')]), screen([el(2, 'View')])).isEmpty, isTrue);
  });

  test('attributes: only what changed, and the neutral value for what went away', () {
    final m = diffTrees(
      screen([
        el(2, 'ScrollView', attrs: {'sx': 0, 'sy': 0, 'bg': '#fff', 'disabled': true, 'r': 4})
      ]),
      screen([
        el(2, 'ScrollView', attrs: {'sx': 0, 'sy': 120, 'r': 4})
      ]),
    );
    expect(json(m)['attributes'], [
      {
        'id': 2,
        'attributes': {'sy': 120, 'bg': 'transparent', 'disabled': false}
      },
    ]);
  });

  test('texts change by the text node\'s id', () {
    final m = diffTrees(screen([el(2, 'Text', text: 'Adet: 2')]), screen([el(2, 'Text', text: 'Adet: 3')]));
    expect(json(m)['texts'], [
      {'id': 3, 'value': 'Adet: 3'}
    ]);
  });

  test('an added subtree is one add with its children inside', () {
    final m = diffTrees(
      screen([el(2, 'View')]),
      screen([
        el(2, 'View', children: [
          el(4, 'Modal', children: [el(6, 'Text', text: 'Onayla')])
        ])
      ]),
    );
    final adds = json(m)['adds']! as List;
    expect(adds, hasLength(1));
    expect((adds.single as Map)['parentId'], 2);
    expect(((adds.single as Map)['node'] as Map)['id'], 4);
  });

  test('a removed subtree is one remove', () {
    final m = diffTrees(
      screen([
        el(2, 'View', children: [
          el(4, 'Modal', children: [el(6, 'Text', text: 'x')])
        ])
      ]),
      screen([el(2, 'View')]),
    );
    expect(json(m)['removes'], [
      {'id': 4}
    ]);
  });

  test('a node that moved to another parent is replaced, with what it carries', () {
    final m = diffTrees(
      screen([
        el(2, 'View', children: [el(6, 'Text', text: 'a')]),
        el(4, 'View')
      ]),
      screen([
        el(2, 'View'),
        el(4, 'View', children: [el(6, 'Text', text: 'a')])
      ]),
    );
    expect(json(m)['removes'], [
      {'id': 6}
    ]);
    expect((json(m)['adds']! as List).map((a) => ((a as Map)['parentId'], (a['node'] as Map)['id'])), [(4, 6)]);
  });

  test('gaining or losing a text child, or changing tag, replaces the element', () {
    final typed = diffTrees(screen([el(2, 'TextInput')]), screen([el(2, 'TextInput', text: 'YAZ25')]));
    expect(json(typed)['removes'], [
      {'id': 2}
    ]);
    expect((json(typed)['adds']! as List).single, containsPair('parentId', 1));

    final retagged = diffTrees(screen([el(2, 'View')]), screen([el(2, 'Pressable')]));
    expect(json(retagged)['removes'], [
      {'id': 2}
    ]);
    expect(json(retagged)['adds'], hasLength(1));
  });

  test('a child of a replaced node is carried, not added twice', () {
    final m = diffTrees(
      screen([
        el(2, 'View', children: [el(4, 'Text', text: 'x')])
      ]),
      screen([
        el(2, 'Pressable', children: [el(4, 'Text', text: 'x')])
      ]),
    );
    expect(json(m)['adds'], hasLength(1));
    expect(json(m)['removes'], [
      {'id': 2}
    ]);
  });

  // ---- read back by a reader that only appends (MRF §2.2), no move repair ----

  test('a view moved under a wrapper that just appeared: its old copy is removed', () {
    final before = screen([el(6, 'Text', text: 'Kaydet')]);
    final after = screen([
      el(4, 'View', children: [el(6, 'Text', text: 'Kaydet')])
    ]);
    final m = roundTrip(before, after);
    expect(json(m)['removes'], [
      {'id': 6}
    ]);
    expect((json(m)['adds']! as List).map((a) => (a as Map)['parentId']), [1]);
  });

  test('reordered siblings: the ones out of place are sent again, in order', () {
    final m = roundTrip(
      screen([el(2, 'Text', text: 'a'), el(4, 'Text', text: 'b'), el(6, 'Text', text: 'c')]),
      screen([el(2, 'Text', text: 'a'), el(6, 'Text', text: 'c'), el(4, 'Text', text: 'b')]),
    );
    expect(json(m)['removes'], [
      {'id': 4}
    ]);
    expect((json(m)['adds']! as List).map((a) => ((a as Map)['node'] as Map)['id']), [4]);
  });

  test('a view inserted between two others lands between them, not at the end', () {
    final m = roundTrip(
      screen([el(2, 'Text', text: 'a'), el(6, 'Text', text: 'c')]),
      screen([el(2, 'Text', text: 'a'), el(4, 'Text', text: 'b'), el(6, 'Text', text: 'c')]),
    );
    expect((json(m)['adds']! as List).map((a) => ((a as Map)['node'] as Map)['id']), [4, 6]);
  });

  test('appending at the end or taking from the middle re-sends nothing', () {
    final m = roundTrip(
      screen([el(2, 'View'), el(4, 'View'), el(6, 'View')]),
      screen([el(2, 'View'), el(6, 'View'), el(8, 'View')]),
    );
    expect(json(m)['removes'], [
      {'id': 4}
    ]);
    expect((json(m)['adds']! as List).map((a) => ((a as Map)['node'] as Map)['id']), [8]);
  });

  test('turns any tree into any other, across a thousand random edits', () {
    var seed = 42;
    int random(int n) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    }

    var nextId = 4;
    var shape = <int, List<int>>{1: <int>[]};
    final texts = <int, String>{};
    MobileNode build(int id) {
      if (id == 1) return screen([for (final child in shape[1]!) build(child)]);
      return el(id, texts.containsKey(id) ? 'Text' : 'View',
          attrs: {'y': id}, text: texts[id], children: [for (final child in shape[id]!) build(child)]);
    }

    Set<int> descendants(Map<int, List<int>> of, int id, [Set<int>? into]) {
      final set = into ?? <int>{};
      set.add(id);
      for (final child in of[id]!) {
        descendants(of, child, set);
      }
      return set;
    }

    var before = build(1);
    for (var step = 0; step < 1000; step++) {
      final next = {
        for (final e in shape.entries) e.key: [...e.value]
      };
      int? parentOf(int id) {
        for (final e in next.entries) {
          if (e.value.contains(id)) return e.key;
        }
        return null;
      }

      for (var edits = 1 + random(3); edits > 0; edits--) {
        final all = next.keys.toList();
        final pick = all[random(all.length)];
        final parent = parentOf(pick);
        switch (random(5)) {
          case 0:
            final id = nextId;
            nextId += 2;
            next[id] = <int>[];
            final siblings = next[pick]!;
            siblings.insert(random(siblings.length + 1), id);
          case 1:
            if (parent == null) break;
            next[parent]!.remove(pick);
            for (final id in descendants(next, pick)) {
              next.remove(id);
            }
          case 2:
            if (parent == null) break;
            final inside = descendants(next, pick);
            final targets = next.keys.where((id) => !inside.contains(id)).toList();
            final target = targets[random(targets.length)];
            next[parent]!.remove(pick);
            final siblings = next[target]!;
            siblings.insert(random(siblings.length + 1), pick);
          case 3:
            if (pick == 1) break;
            if (random(2) == 1) {
              texts[pick] = 't$step';
            } else {
              texts.remove(pick);
            }
          default:
            if (parent == null) break;
            final id = nextId;
            nextId += 2;
            next[id] = [pick];
            next[parent] = [for (final c in next[parent]!) c == pick ? id : c];
        }
      }
      shape = next;
      texts.removeWhere((id, _) => !shape.containsKey(id));
      final after = build(1);
      roundTrip(before, after);
      before = after;
    }
    expect(shape.length, greaterThan(5));
  });
}

/// Diffs, applies the mutation the way a reader does — removes, adds appended
/// as the last child, attributes, texts — and expects [after] exactly.
Mutation roundTrip(MobileNode before, MobileNode after) {
  final m = diffTrees(before, after);
  final tree = jsonDecode(jsonEncode(before.toJson())) as Map<String, Object?>;
  final wire = json(m);

  (Map<String, Object?>, Map<String, Object?>?)? find(Map<String, Object?> node, int id, Map<String, Object?>? parent) {
    if (node['id'] == id) return (node, parent);
    for (final child in (node['childNodes'] as List?) ?? const []) {
      final hit = find(child as Map<String, Object?>, id, node);
      if (hit != null) return hit;
    }
    return null;
  }

  Iterable<int> ids(Map<String, Object?> node) sync* {
    yield node['id']! as int;
    for (final child in (node['childNodes'] as List?) ?? const []) {
      yield* ids(child as Map<String, Object?>);
    }
  }

  for (final remove in wire['removes']! as List) {
    final hit = find(tree, (remove as Map)['id'] as int, null);
    expect(hit, isNotNull, reason: 'remove of an id that is not there');
    (hit!.$2!['childNodes']! as List).remove(hit.$1);
  }
  for (final add in wire['adds']! as List) {
    final node = (add as Map)['node'] as Map<String, Object?>;
    for (final id in ids(node)) {
      expect(find(tree, id, null), isNull, reason: 'add of $id, which is already in the tree (MUT-002)');
    }
    final parent = find(tree, add['parentId'] as int, null);
    expect(parent, isNotNull);
    (parent!.$1['childNodes']! as List).add(node);
  }
  for (final change in wire['attributes']! as List) {
    final node = find(tree, (change as Map)['id'] as int, null)!.$1;
    node['attributes'] = {...(node['attributes']! as Map), ...(change['attributes'] as Map)};
  }
  for (final change in wire['texts']! as List) {
    find(tree, (change as Map)['id'] as int, null)!.$1['textContent'] = change['value'];
  }
  expect(tree, jsonDecode(jsonEncode(after.toJson())));
  return m;
}
