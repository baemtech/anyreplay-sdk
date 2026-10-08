/// The recording format's nodes, and what changed between two of them
/// (docs/MOBILE-REPLAY-FORMAT.md §2.2, §3).
///
/// A phone screen is serialised into the node shapes rrweb produces for a
/// page — an element with a text child is what a `<span>` would be — because
/// the server's string extraction, the translation cache and Argus already
/// walk that structure.
library;

/// rrweb node types.
const int elementNode = 2;
const int textNode = 3;

/// rrweb event types a native recording sends.
const int metaEvent = 4;
const int fullSnapshotEvent = 2;
const int incrementalEvent = 3;
const int customEvent = 5;

/// Incremental sources: a mutation, a tap.
const int mutationSource = 0;
const int mouseInteractionSource = 2;

/// One node of a recorded tree. Elements have an even id ≥ 2 (the `Screen`
/// root is 1); an element's text is one text node with id + 1, its first child.
class MobileNode {
  MobileNode.element(this.id, String this.tag, [Map<String, Object>? attributes])
      : type = elementNode,
        attributes = attributes ?? <String, Object>{},
        children = <MobileNode>[],
        text = null;

  MobileNode.text(this.id, String this.text)
      : type = textNode,
        tag = null,
        attributes = const <String, Object>{},
        children = const <MobileNode>[];

  final int type;
  final int id;
  final String? tag;
  final Map<String, Object> attributes;
  final List<MobileNode> children;
  final String? text;

  bool get isElement => type == elementNode;

  /// The element's text node, if it has one.
  MobileNode? get textChild => children.isNotEmpty && children.first.type == textNode ? children.first : null;

  Map<String, Object?> toJson() => type == textNode
      ? {'type': textNode, 'id': id, 'textContent': text}
      : {
          'type': elementNode,
          'id': id,
          'tagName': tag,
          'attributes': attributes,
          'childNodes': [for (final child in children) child.toJson()],
        };
}

/// What changed between two trees, in the order a reader applies it.
class Mutation {
  final List<Map<String, Object?>> removes = [];
  final List<Map<String, Object?>> adds = [];
  final List<Map<String, Object?>> attributes = [];
  final List<Map<String, Object?>> texts = [];

  bool get isEmpty => removes.isEmpty && adds.isEmpty && attributes.isEmpty && texts.isEmpty;

  Map<String, Object?> toJson() => {
        'source': mutationSource,
        'removes': removes,
        'adds': adds,
        'attributes': attributes,
        'texts': texts,
      };
}

/// What a key that disappeared is reset to. A mutation can only merge
/// attributes over the old ones (MRF §2.2), so a key that goes away has to
/// be sent as the value that means "not set". The React Native SDK's table.
const Map<String, Object> neutralAttributes = {
  'disabled': false,
  'masked': false,
  'it': false,
  'on': false,
  'op': 1,
  'z': 0,
  'sx': 0,
  'sy': 0,
  'lines': 1,
  'fw': 400,
  'ff': 'system',
  'al': 'left',
  'bg': 'transparent',
  'bc': 'transparent',
  'placeholder': '',
  'aria-label': '',
  'alt': '',
};

class _Indexed {
  _Indexed(this.node, this.parent);
  final MobileNode node;
  final int? parent;
}

void _index(MobileNode node, int? parent, Map<int, _Indexed> into) {
  into[node.id] = _Indexed(node, parent);
  if (node.type != elementNode) return;
  for (final child in node.children) {
    if (child.type == elementNode) _index(child, node.id, into);
  }
}

bool _sameValue(Object? a, Object? b) {
  if (a is num && b is num) return a == b;
  return a == b;
}

/// The mutation that turns [before] into [after].
///
/// A node that is new, or whose place changed — another parent, another tag,
/// a text child gained or lost — is sent whole as an add (its descendants
/// travel inside it), and its old copy, if any, is removed first: "an id
/// removed and re-added in one batch is a replacement". Everything else is
/// a change of attributes or of text.
Mutation diffTrees(MobileNode before, MobileNode after) {
  final mutation = Mutation();
  final oldIndex = <int, _Indexed>{};
  final newIndex = <int, _Indexed>{};
  _index(before, null, oldIndex);
  _index(after, null, newIndex);

  bool moved(int id) {
    final was = oldIndex[id];
    final now = newIndex[id];
    if (was == null || now == null) return true;
    if (was.parent != now.parent) return true;
    if (was.node.tag != now.node.tag) return true;
    return (was.node.textChild == null) != (now.node.textChild == null);
  }

  // Removes: the top of every old region that no longer stands where it did.
  void collectRemoves(MobileNode node, bool ancestorGone) {
    final gone = moved(node.id);
    if (gone && !ancestorGone && node.id != 1) mutation.removes.add({'id': node.id});
    for (final child in node.children) {
      if (child.type == elementNode) collectRemoves(child, ancestorGone || gone);
    }
  }

  collectRemoves(before, false);

  void walk(MobileNode node, bool carried) {
    final fresh = node.id != 1 && moved(node.id);
    if (fresh && !carried) {
      mutation.adds.add({'parentId': newIndex[node.id]!.parent, 'node': node.toJson()});
    }
    if (!fresh) {
      final previous = oldIndex[node.id]!.node;
      final changed = <String, Object>{};
      node.attributes.forEach((key, value) {
        if (!_sameValue(previous.attributes[key], value)) changed[key] = value;
      });
      previous.attributes.forEach((key, value) {
        if (node.attributes.containsKey(key)) return;
        final neutral = neutralAttributes[key];
        if (neutral != null && !_sameValue(neutral, value)) changed[key] = neutral;
      });
      if (changed.isNotEmpty) mutation.attributes.add({'id': node.id, 'attributes': changed});
      final text = node.textChild;
      final oldText = previous.textChild;
      if (text != null && oldText != null && text.text != oldText.text) {
        mutation.texts.add({'id': text.id, 'value': text.text});
      }
    }
    for (final child in node.children) {
      if (child.type == elementNode) walk(child, carried || fresh);
    }
  }

  walk(after, false);
  return mutation;
}
