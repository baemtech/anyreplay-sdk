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
}
