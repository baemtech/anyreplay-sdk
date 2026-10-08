import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import 'framework_painters.g.dart';
import 'icons.dart';
import 'mask_widget.dart';
import 'masking.dart';
import 'tree.dart';

/// Reads a Flutter screen into the recording format
/// (docs/MOBILE-REPLAY-FORMAT.md), as words and boxes — never pixels.
///
/// It walks the **element** tree from the root, and reads geometry from each
/// element's **render object**. Neither alone is enough: the widget says what
/// a thing is (a `Switch` that is on, a `TextField` that is a password, the
/// name of an `Icon`, the address of an `Image`), the render object says
/// where it is on screen (its paint transform to the root, in logical pixels)
/// and how it is drawn (`RenderParagraph`'s text and style, a decorated box's
/// colour and corners, an opacity). So the walk carries widget context down
/// — masked, inside a text field, inside a button — and records a node
/// wherever a widget or a render object draws or means something.
///
/// Everything is read between frames (the recorder never ticks mid-frame),
/// from public framework API. Third-party web views, maps and video players
/// are recognised by their widget's type name, which an `--obfuscate` build
/// renames: they then fall back to an opaque `Canvas` (platform views) or
/// `Video` (textures) box.

/// What the screen is, for one capture.
class CaptureScreen {
  const CaptureScreen({
    required this.size,
    this.statusBar = 0,
    this.bottomInset = 0,
    this.keyboard = 0,
  });

  /// Logical size of the view.
  final Size size;

  /// Height of the status bar (the view's top padding).
  final double statusBar;

  /// Height of the home indicator or navigation bar, when no keyboard covers it.
  final double bottomInset;

  /// Height of the on-screen keyboard (the view's bottom inset).
  final double keyboard;
}

class CaptureSettings {
  const CaptureSettings({
    this.maskAllInputs = false,
    this.maskAllTyping = false,
    this.maskImages = false,
    this.assetHash,
  });

  final bool maskAllInputs;
  final bool maskAllTyping;
  final bool maskImages;

  /// The confirmed content hash of a bundled asset, by its key; null while
  /// it is not known yet (the uploader works in the background).
  final String? Function(String assetKey)? assetHash;
}

/// Turns the element tree into a `Screen` tree. Keeps element ids between
/// captures — an element keeps its id for as long as it is mounted, which is
/// what makes a diff a diff.
class TreeCapture {
  TreeCapture(this.settings);

  final CaptureSettings settings;
  final Expando<int> _ids = Expando<int>('anyreplay.id');
  int _next = 2;
  final Object _keyboardKey = Object();
  final Object _statusBarKey = Object();
  final Object _homeBarKey = Object();

  /// Nodes recorded by the last capture; for the performance log.
  int lastNodeCount = 0;

  int _idOf(Object key) {
    final known = _ids[key];
    if (known != null) return known;
    final id = _next;
    _next += 2;
    _ids[key] = id;
    return id;
  }

  /// The tree under [root] as it is on screen now.
  MobileNode capture(Element? root, CaptureScreen screen) {
    final width = screen.size.width.round();
    final height = screen.size.height.round();
    final node = MobileNode.element(1, 'Screen', {'x': 0, 'y': 0, 'w': width, 'h': height});
    final pass = _Pass(this, Offset.zero & screen.size, node);
    if (root != null) {
      try {
        pass.visit(root, pass.rootFrame);
      } catch (error) {
        // A tree that changed under the walk, or a widget nobody foresaw: a
        // screen with fewer boxes is still a recording; a recorder that
        // throws into the app is not acceptable.
        assert(() {
          debugPrint('[anyreplay] capture stopped early: $error');
          return true;
        }());
      }
    }
    _layers(node, screen, width, height);
    lastNodeCount = pass.count;
    return node;
  }

  /// The keyboard and the system bars: frames only, never their contents.
  void _layers(MobileNode screenNode, CaptureScreen screen, int width, int height) {
    final keyboard = screen.keyboard.round();
    if (keyboard > 0 && keyboard < height) {
      screenNode.children.add(MobileNode.element(
          _idOf(_keyboardKey), 'Keyboard', {'x': 0, 'y': height - keyboard, 'w': width, 'h': keyboard}));
    }
    final top = screen.statusBar.round();
    if (top > 0 && top < height) {
      screenNode.children
          .add(MobileNode.element(_idOf(_statusBarKey), 'SystemBar', {'x': 0, 'y': 0, 'w': width, 'h': top}));
    }
    final bottom = screen.bottomInset.round();
    if (bottom > 0 && keyboard <= 0 && bottom < height) {
      screenNode.children.add(
          MobileNode.element(_idOf(_homeBarKey), 'SystemBar', {'x': 0, 'y': height - bottom, 'w': width, 'h': bottom}));
    }
  }
}

/// What a text field says about itself, from the `TextField` above its
/// `EditableText`.
class _Field {
  const _Field({this.hint, this.label, this.keyName, this.restorationId, this.enabled = true});
  final String? hint;
  final String? label;
  final String? keyName;
  final String? restorationId;
  final bool enabled;
}

/// The walk's context at one element.
class _Frame {
  const _Frame({
    required this.node,
    required this.rect,
    this.scroll = Offset.zero,
    this.masked = false,
    this.opacity = 1,
    this.pending,
    this.field,
    this.fieldKey,
    this.inPressable = false,
    this.radioGroup = const _Unset(),
  });

  /// The nearest recorded ancestor, and its box on screen.
  final MobileNode node;
  final Rect rect;

  /// The content offset when [node] is a scroll view: children are recorded
  /// in content coordinates (MRF §6).
  final Offset scroll;

  /// Inside an [AnyReplayMask], or inside a masked element.
  final bool masked;

  /// Opacity of the unrecorded wrappers since [node].
  final double opacity;

  /// An accessible name and role from a `Semantics` above, waiting for the
  /// first node recorded below it to carry them.
  final _Pending? pending;
  String? get label => pending == null || pending!.consumed ? null : pending!.label;
  String? get role => pending == null || pending!.consumed ? null : pending!.role;
  final _Field? field;
  final String? fieldKey;
  final bool inPressable;
  final Object? radioGroup;

  _Frame copy({
    MobileNode? node,
    Rect? rect,
    Offset? scroll,
    bool? masked,
    double? opacity,
    Object? pending = const _Unset(),
    Object? field = const _Unset(),
    Object? fieldKey = const _Unset(),
    bool? inPressable,
    Object? radioGroup = const _Unset(),
  }) =>
      _Frame(
        node: node ?? this.node,
        rect: rect ?? this.rect,
        scroll: scroll ?? this.scroll,
        masked: masked ?? this.masked,
        opacity: opacity ?? this.opacity,
        pending: pending is _Unset ? this.pending : pending as _Pending?,
        field: field is _Unset ? this.field : field as _Field?,
        fieldKey: fieldKey is _Unset ? this.fieldKey : fieldKey as String?,
        inPressable: inPressable ?? this.inPressable,
        radioGroup: radioGroup is _Unset ? this.radioGroup : radioGroup,
      );

  /// This frame's own context, attached under [other]'s node instead.
  _Frame under(_Frame other) =>
      copy(node: other.node, rect: other.rect, scroll: other.scroll, inPressable: other.inPressable);
}

class _Unset {
  const _Unset();
}

/// A `Semantics` label and role, carried by the first node recorded below
/// it and by no other: siblings further down a `Column` are not what it names.
class _Pending {
  _Pending(this.label, this.role);
  final String? label;
  final String? role;
  bool consumed = false;
}

/// What one element turned out to be.
class _Rec {
  _Rec(this.tag, this.box, {Map<String, Object>? attributes, this.text, this.leaf = true})
      : attributes = attributes ?? <String, Object>{};

  final String tag;
  final RenderBox box;
  final Map<String, Object> attributes;
  final String? text;

  /// Its subtree is not walked: it is recorded whole (a field, an icon, a
  /// switch), or never looked inside (a web view).
  final bool leaf;

  /// Masked by its own nature (a password field), not only by its place.
  bool masked = false;

  /// Only a background or a border: merged into the parent when it covers
  /// exactly the parent's box.
  bool decoration = false;

  /// A modal barrier: everything painted after it is a child of its layer.
  bool barrier = false;

  /// Takes the pending accessible name from a `Semantics` above.
  bool takesLabel = false;
  Offset scroll = Offset.zero;
}

/// One capture's walk.
class _Pass {
  _Pass(this.capture, this.screen, MobileNode root) : rootFrame = _Frame(node: root, rect: screen);

  final TreeCapture capture;
  final Rect screen;
  final _Frame rootFrame;
  final Map<RenderObject, Matrix4?> _transforms = {};
  int count = 0;

  CaptureSettings get settings => capture.settings;

  // ------------------------------------------------------------- geometry --

  Matrix4? _toRoot(RenderObject object) {
    if (_transforms.containsKey(object)) return _transforms[object];
    final parent = object.parent;
    Matrix4? matrix;
    if (parent is RenderView) {
      // Logical pixels: the view's own device-pixel-ratio transform is left out.
      matrix = Matrix4.identity();
    } else if (parent != null) {
      final above = _toRoot(parent);
      if (above != null) {
        matrix = above.clone();
        try {
          parent.applyPaintTransform(object, matrix);
        } catch (_) {
          matrix = null;
        }
      }
    }
    _transforms[object] = matrix;
    return matrix;
  }

  Rect? _rectOf(RenderBox box) {
    if (!box.attached || !box.hasSize) return null;
    final matrix = _toRoot(box);
    if (matrix == null) return null;
    final rect = MatrixUtils.transformRect(matrix, Offset.zero & box.size);
    if (!rect.isFinite) return null;
    return rect;
  }

  static RenderBox? _boxOf(Element element) {
    final object = element is RenderObjectElement ? element.renderObject : element.findRenderObject();
    return object is RenderBox ? object : null;
  }

  // ----------------------------------------------------------------- walk --

  /// Visits [element]; returns the frame later siblings attach to when a
  /// modal barrier was recorded inside it.
  _Frame? visit(Element element, _Frame frame) {
    final widget = element.widget;
    var f = frame;

    // Not on screen: offstage overlay entries (the routes under an opaque
    // one), `Offstage`, `Visibility(visible: false)`, `IndexedStack`'s other
    // children, anything at opacity 0.
    if (widget is TickerMode && !widget.enabled) return null;
    if (widget is Offstage && widget.offstage) return null;
    if (widget is Visibility && !widget.visible) return null;
    if (element is RenderObjectElement) {
      final object = element.renderObject;
      if (object is RenderOffstage && object.offstage) return null;
      double? opacity;
      if (object is RenderOpacity) opacity = object.opacity;
      if (object is RenderAnimatedOpacity) opacity = object.opacity.value;
      if (object is RenderSliverOpacity) opacity = object.opacity;
      if (object is RenderSliverAnimatedOpacity) opacity = object.opacity.value;
      if (opacity != null) {
        final combined = f.opacity * opacity;
        if (combined <= 0.004) return null;
        f = f.copy(opacity: combined);
      }
    }

    // Context that only changes how what is below is read.
    if (widget is AnyReplayMask) f = f.copy(masked: true);
    if (widget is Semantics) f = _withSemantics(f, widget.properties);
    if (widget is TextFormField) f = f.copy(fieldKey: _keyName(widget.key));
    if (widget is TextField) {
      final decoration = widget.decoration;
      f = f.copy(
        field: _Field(
          hint: decoration?.hintText,
          label: decoration?.labelText,
          keyName: _keyName(widget.key) ?? f.fieldKey,
          restorationId: widget.restorationId,
          enabled: widget.enabled != false && decoration?.enabled != false,
        ),
      );
    } else if (widget is CupertinoTextField) {
      f = f.copy(
        field: _Field(
          hint: widget.placeholder,
          keyName: _keyName(widget.key) ?? f.fieldKey,
          restorationId: widget.restorationId,
          enabled: widget.enabled,
        ),
      );
    }
    if (element is StatefulElement && _isRadioGroup(widget)) {
      try {
        f = f.copy(radioGroup: (element.state as dynamic).groupValue);
      } catch (_) {/* an older or newer RadioGroup: radios report unknown */}
    }

    _Rec? rec;
    try {
      rec = _classify(element, widget, f);
    } catch (error) {
      // One widget nobody foresaw must not cost the rest of the screen.
      assert(() {
        debugPrint('[anyreplay] could not read ${widget.runtimeType}: $error');
        return true;
      }());
    }
    if (rec == null) return _walkChildren(element, f);

    final rect = _rectOf(rec.box);
    if (rect == null) return rec.leaf ? null : _walkChildren(element, f);

    // A button inside a button of the same size (an `IconButton` and the
    // `ButtonStyleButton` it builds), a sheet inside a sheet (a `BottomSheet`
    // handed to `Scaffold.bottomSheet`, which wraps it in its own) is one.
    if ((rec.tag == 'Pressable' || rec.tag == 'Sheet') && f.node.tag == rec.tag && _sameRect(rect, f.rect)) {
      // The inner one knows whether it can be pressed (a `BackButton` is an
      // `IconButton` subclass whose own `onPressed` is null).
      if (rec.tag == 'Pressable') {
        if (rec.attributes['disabled'] == true) {
          f.node.attributes['disabled'] = true;
        } else {
          f.node.attributes.remove('disabled');
        }
      }
      return _walkChildren(element, f);
    }
    if (rec.decoration && _covers(rect, f)) {
      for (final entry in rec.attributes.entries) {
        f.node.attributes.putIfAbsent(entry.key, () => entry.value);
      }
      return _walkChildren(element, f);
    }

    final masked = f.masked || rec.masked;
    final node = _record(element, rec, rect, f, masked);
    if (node == null) return rec.leaf ? null : _walkChildren(element, f);

    final inner = _Frame(
      node: node,
      rect: rect,
      scroll: rec.scroll,
      masked: masked,
      field: f.field,
      fieldKey: f.fieldKey,
      inPressable: f.inPressable || rec.tag == 'Pressable',
      radioGroup: f.radioGroup,
    );
    if (rec.barrier) return inner;
    if (rec.leaf) return null;
    return _walkChildren(element, inner);
  }

  _Frame? _walkChildren(Element element, _Frame frame) {
    _Frame? carry;
    var current = frame;
    // `IndexedStack` lays out every child and paints one.
    final object = element is RenderObjectElement ? element.renderObject : null;
    final shown = object is RenderIndexedStack ? object.index : null;
    var index = -1;
    element.visitChildren((child) {
      index += 1;
      if (object is RenderIndexedStack && index != shown) return;
      final next = visit(child, current);
      if (next != null) {
        // Everything painted after a modal barrier is above it: the layer
        // becomes the parent of the siblings that follow.
        carry = next;
        current = frame.under(next);
      }
    });
    return carry;
  }

  static bool _isLayer(String tag) => tag == 'Modal' || tag == 'Sheet';
  static bool _isLayerParent(MobileNode node) => node.id == 1 || node.tag == 'Modal' || node.tag == 'Sheet';

  bool _covers(Rect rect, _Frame f) {
    if (f.node.id == 1) return false;
    if (f.node.attributes.containsKey('bg') || f.node.attributes.containsKey('grad')) return false;
    return _sameRect(rect, f.rect);
  }

  static bool _sameRect(Rect a, Rect b) =>
      (a.left - b.left).abs() < 0.5 &&
      (a.top - b.top).abs() < 0.5 &&
      (a.right - b.right).abs() < 0.5 &&
      (a.bottom - b.bottom).abs() < 0.5;

  MobileNode? _record(Element element, _Rec rec, Rect rect, _Frame frame, bool masked) {
    if (!rect.overlaps(screen)) return null;
    // A sheet or dialog layer found inside the page is drawn over the screen:
    // the format wants it as a child of Screen (or of another layer).
    final f = _isLayer(rec.tag) && !_isLayerParent(frame.node) ? frame.under(rootFrame) : frame;
    final x = (rect.left - f.rect.left + f.scroll.dx).round();
    final y = (rect.top - f.rect.top + f.scroll.dy).round();
    final w = rect.width.round();
    final h = rect.height.round();
    if (w <= 0 || h <= 0) return null;

    final id = capture._idOf(element);
    final attributes = <String, Object>{'x': x, 'y': y, 'w': w, 'h': h, ...rec.attributes};
    final label = frame.label;
    final role = frame.role;
    frame.pending?.consumed = true;
    if (rec.takesLabel && label != null && !attributes.containsKey('aria-label')) attributes['aria-label'] = label;
    // Inside a button, "button" says nothing its parent does not.
    if (role != null && !attributes.containsKey('role') && !(role == 'button' && frame.inPressable)) {
      attributes['role'] = role;
    }
    final opacity = frame.opacity;
    if (opacity < 0.995) attributes['op'] = (opacity * 100).round() / 100;
    if (masked) {
      attributes['masked'] = true;
      attributes.remove('src');
      attributes.remove('asset');
      for (final key in const ['aria-label', 'alt']) {
        if (attributes.containsKey(key)) attributes[key] = maskText;
      }
    }

    final node = MobileNode.element(id, rec.tag, attributes);
    final text = rec.text;
    if (text != null && text.isNotEmpty) node.children.add(MobileNode.text(id + 1, masked ? maskText : text));
    f.node.children.add(node);
    count += 1;
    return node;
  }

  // ------------------------------------------------------------- semantics --

  _Frame _withSemantics(_Frame f, SemanticsProperties p) {
    String? role;
    if (p.button == true) {
      role = 'button';
    } else if (p.link == true) {
      role = 'link';
    } else if (p.header == true) {
      role = 'header';
    } else if (p.image == true) {
      role = 'image';
    }
    final label = p.label;
    final named = label != null && label.trim().isNotEmpty ? label : f.label;
    final resolvedRole = role ?? f.role;
    if (named == null && resolvedRole == null) return f;
    return f.copy(pending: _Pending(named, resolvedRole));
  }

  static final Map<Type, bool> _radioGroups = {};

  /// `RadioGroup` (Flutter 3.35+), by name: older Flutter versions have none to import.
  static bool _isRadioGroup(Widget widget) =>
      _radioGroups.putIfAbsent(widget.runtimeType, () => widget.runtimeType.toString().startsWith('RadioGroup<'));

  static String? _keyName(Key? key) {
    if (key is ValueKey<String>) return key.value;
    return null;
  }

  // -------------------------------------------------------- classification --

  _Rec? _classify(Element element, Widget widget, _Frame f) {
    final library = _libraryTag(widget.runtimeType);
    if (library != null) {
      final box = _boxOf(element);
      if (box == null) return null;
      return _Rec(library, box)..takesLabel = true;
    }

    if (widget is EditableText) return _editable(element, widget, f);
    if (widget is Icon) return _icon(element, widget, f);
    if (widget is Image) return _image(element, widget, f);
    if (widget is RawImage) {
      final box = _boxOf(element);
      return box == null ? null : (_Rec('Image', box)..masked = settings.maskImages);
    }
    if (widget is RichText) return _richText(element, widget, f);

    if (widget is Switch) return _control(element, 'Switch', on: widget.value, disabled: widget.onChanged == null);
    if (widget is CupertinoSwitch) {
      return _control(element, 'Switch', on: widget.value, disabled: widget.onChanged == null);
    }
    if (widget is Checkbox) {
      return _control(element, 'Checkbox', on: widget.value ?? 'mixed', disabled: widget.onChanged == null);
    }
    if (widget is CupertinoCheckbox) {
      return _control(element, 'Checkbox', on: widget.value ?? 'mixed', disabled: widget.onChanged == null);
    }
    if (widget is Radio) return _radio(element, widget, f);
    if (widget is Slider) {
      return _control(element, 'Slider',
          disabled: widget.onChanged == null, range: (widget.value, widget.min, widget.max));
    }
    if (widget is CupertinoSlider) {
      return _control(element, 'Slider',
          disabled: widget.onChanged == null, range: (widget.value, widget.min, widget.max));
    }
    if (widget is ProgressIndicator) {
      final value = widget.value;
      return _control(element, 'Progress', range: value == null ? null : (value.clamp(0.0, 1.0), 0, 1));
    }
    if (widget is CupertinoActivityIndicator) return _control(element, 'Progress');

    if (widget is DropdownButton) {
      final box = _boxOf(element);
      if (box == null) return null;
      // Read through `dynamic`: `DropdownButton<String>` seen as
      // `DropdownButton<dynamic>` would fail the covariant check on `onChanged`.
      final Object? onChanged = (widget as dynamic).onChanged;
      return _Rec('Picker', box,
          attributes: {'mode': 'select', if (onChanged == null) 'disabled': true}, text: _collectText(element))
        ..takesLabel = true;
    }
    if (widget is SegmentedButton ||
        widget is CupertinoSlidingSegmentedControl ||
        widget is CupertinoSegmentedControl) {
      return _container(element, 'Picker', {'mode': 'segmented'});
    }
    if (widget is CupertinoDatePicker) {
      return _container(element, 'Picker', {'mode': widget.mode == CupertinoDatePickerMode.time ? 'time' : 'date'});
    }
    if (widget is CupertinoTimerPicker) return _container(element, 'Picker', {'mode': 'time'});
    if (widget is CupertinoPicker) return _container(element, 'Picker', {'mode': 'wheel'});

    if (widget is ButtonStyleButton) return _pressable(element, disabled: !widget.enabled);
    if (widget is IconButton) return _pressable(element, disabled: widget.onPressed == null, label: widget.tooltip);
    if (widget is FloatingActionButton) {
      return _pressable(element, disabled: widget.onPressed == null, label: widget.tooltip);
    }
    if (widget is CupertinoButton) return _pressable(element, disabled: widget.onPressed == null);
    if (!f.inPressable) {
      if (widget is InkResponse && (widget.onTap != null || widget.onLongPress != null)) return _pressable(element);
      if (widget is GestureDetector && (widget.onTap != null || widget.onLongPress != null)) return _pressable(element);
      if (widget is ListTile && (widget.onTap != null || widget.onLongPress != null)) {
        return _pressable(element, disabled: !widget.enabled);
      }
    }

    if (widget is Scrollable) return _scrollable(element, widget);
    if (widget is ModalBarrier) return _barrier(element, widget);
    if (widget is BottomSheet || widget is CupertinoActionSheet || widget is CupertinoPopupSurface) {
      return _container(element, 'Sheet', {});
    }
    if (widget is CustomPaint && _isAppPainter(widget)) {
      final box = _boxOf(element);
      if (box == null) return null;
      return _Rec('Canvas', box, leaf: widget.child == null)..takesLabel = true;
    }
    if (widget is Texture) {
      final box = _boxOf(element);
      return box == null ? null : (_Rec('Video', box)..takesLabel = true);
    }
    if (widget is ColoredBox) {
      final box = _boxOf(element);
      final bg = _colour(widget.color);
      if (box == null || bg == null) return null;
      return _Rec('View', box, attributes: {'bg': bg}, leaf: false)
        ..decoration = true
        ..takesLabel = true;
    }

    if (element is RenderObjectElement) {
      final object = element.renderObject;
      if (object is RenderDecoratedBox) return _decorated(object, object.decoration);
      if (object is RenderPhysicalModel) return _physicalModel(object);
      if (object is RenderPhysicalShape) return _physicalShape(object);
      if (object is PlatformViewRenderBox || object is RenderDarwinPlatformView) {
        return _Rec('Canvas', object as RenderBox)..takesLabel = true;
      }
    }
    return null;
  }

  _Rec? _container(Element element, String tag, Map<String, Object> attributes) {
    final box = _boxOf(element);
    if (box == null) return null;
    return _Rec(tag, box, attributes: attributes, leaf: false)..takesLabel = true;
  }

  _Rec? _control(Element element, String tag, {Object? on, bool disabled = false, (double, double, double)? range}) {
    final box = _boxOf(element);
    if (box == null) return null;
    final attributes = <String, Object>{
      if (on != null) 'on': on,
      if (range != null) ...{'val': _number(range.$1), 'min': _number(range.$2), 'max': _number(range.$3)},
      if (disabled) 'disabled': true,
    };
    return _Rec(tag, box, attributes: attributes)..takesLabel = true;
  }

  _Rec? _radio(Element element, Radio<dynamic> widget, _Frame f) {
    // ignore: deprecated_member_use
    final Object? group = widget.groupValue ?? (f.radioGroup is _Unset ? null : f.radioGroup);
    final rec = _control(element, 'Checkbox', on: widget.value == group);
    rec?.attributes['role'] = 'radio';
    return rec;
  }

  _Rec? _pressable(Element element, {bool disabled = false, String? label}) {
    final box = _boxOf(element);
    if (box == null) return null;
    return _Rec('Pressable', box,
        attributes: {
          'role': 'button',
          if (disabled) 'disabled': true,
          if (label != null && label.trim().isNotEmpty) 'aria-label': label,
        },
        leaf: false)
      ..takesLabel = true;
  }

  _Rec? _scrollable(Element element, Scrollable widget) {
    final box = _boxOf(element);
    if (box == null || element is! StatefulElement) return null;
    var pixels = 0.0;
    final state = element.state;
    if (state is ScrollableState) {
      final position = state.position;
      if (position.hasPixels && position.pixels.isFinite) pixels = position.pixels;
    }
    // Children are placed at (on-screen position + offset), so a reader that
    // draws them at (position − offset) puts them where they were, whichever
    // way the list grows.
    final offset = switch (widget.axisDirection) {
      AxisDirection.down => Offset(0, pixels),
      AxisDirection.up => Offset(0, -pixels),
      AxisDirection.right => Offset(pixels, 0),
      AxisDirection.left => Offset(-pixels, 0),
    };
    final sx = offset.dx.round().clamp(-1000000, 1000000);
    final sy = offset.dy.round().clamp(-1000000, 1000000);
    return _Rec('ScrollView', box, attributes: {'sx': sx, 'sy': sy}, leaf: false)
      ..scroll = Offset(sx.toDouble(), sy.toDouble())
      ..takesLabel = true;
  }

  _Rec? _barrier(Element element, ModalBarrier widget) {
    final color = widget.color;
    final visible = color != null && color.a > 0;
    // Every page route has a barrier too, transparent and not dismissible;
    // only a dialog's, a sheet's or a menu's is a layer.
    if (!visible && !widget.dismissible) return null;
    final box = _boxOf(element);
    if (box == null) return null;
    final bg = visible ? _colour(color) : null;
    return _Rec('Modal', box, attributes: {if (bg != null) 'bg': bg})..barrier = true;
  }

  // ----------------------------------------------------------------- words --

  _Rec? _richText(Element element, RichText widget, _Frame f) {
    final object = element is RenderObjectElement ? element.renderObject : null;
    if (object is! RenderParagraph) return null;
    final text = widget.text.toPlainText(includeSemanticsLabels: false, includePlaceholders: false);
    if (text.trim().isEmpty) return null;
    // The field's hint is its placeholder, drawn by the reader inside the field.
    final hint = f.field?.hint;
    if (hint != null && text == hint) return null;

    final style = widget.text.style;
    final family = style?.fontFamily;
    if ((family == 'MaterialIcons' || family == 'CupertinoIcons') && text.runes.length == 1) {
      // A glyph drawn with Text: an icon by any other name.
      final named = namedIconFor(text.runes.first, family);
      final attributes = <String, Object>{
        if (named != null) 'iconSet': named.iconSet,
        if (named != null) 'glyph': named.name,
        if (_colour(style?.color) case final colour?) 'color': colour,
      };
      return _Rec('Icon', object, attributes: attributes)..takesLabel = true;
    }

    final attributes = _textStyle(style, object.textScaler, object.textAlign, object.textDirection);
    final lines = _lines(object, style, widget.maxLines);
    if (lines > 1) attributes['lines'] = lines;
    return _Rec('Text', object, attributes: attributes, text: text);
  }

  Map<String, Object> _textStyle(TextStyle? style, TextScaler scaler, TextAlign align, TextDirection direction) {
    final attributes = <String, Object>{};
    final colour = _colour(style?.color);
    if (colour != null) attributes['color'] = colour;
    final size = scaler.scale(style?.fontSize ?? 14);
    if (size.isFinite && size > 0) attributes['size'] = _number(size);
    final weight = style?.fontWeight;
    if (weight != null) {
      final value = (FontWeight.values.indexOf(weight) + 1) * 100;
      if (value != 400 && value >= 100) attributes['fw'] = value;
    }
    if (style?.fontStyle == FontStyle.italic) attributes['it'] = true;
    final hint = _fontHint(style?.fontFamily);
    if (hint != null) attributes['ff'] = hint;
    final al = switch (align) {
      TextAlign.center => 'center',
      TextAlign.justify => 'justify',
      TextAlign.right => 'right',
      TextAlign.left => null,
      TextAlign.start => direction == TextDirection.rtl ? 'right' : null,
      TextAlign.end => direction == TextDirection.rtl ? null : 'right',
    };
    if (al != null) attributes['al'] = al;
    return attributes;
  }

  /// How many lines the paragraph was laid out on.
  int _lines(RenderParagraph paragraph, TextStyle? style, int? maxLines) {
    if (maxLines == 1) return 1;
    final size = paragraph.textScaler.scale(style?.fontSize ?? 14);
    final lineHeight = size * (style?.height ?? 1.2);
    if (!paragraph.hasSize || paragraph.size.height < lineHeight * 1.5) return 1;
    try {
      final plain = paragraph.text.toPlainText(includeSemanticsLabels: false);
      final boxes = paragraph.getBoxesForSelection(TextSelection(baseOffset: 0, extentOffset: plain.length));
      final tops = <int>{for (final box in boxes) box.top.round()};
      if (tops.isNotEmpty) return math.min(tops.length, 1000);
    } catch (_) {/* fall back to the estimate */}
    return math.max(1, math.min(1000, (paragraph.size.height / lineHeight).round()));
  }

  static String? _fontHint(String? family) {
    if (family == null) return null;
    final name = family.toLowerCase();
    if (RegExp(r'mono|courier|menlo|consol|code|fira ?code|jetbrains').hasMatch(name)) return 'mono';
    if (name.contains('rounded') || name.contains('nunito') || name.contains('quicksand') || name.contains('varela')) {
      return 'rounded';
    }
    if (name.contains('serif') && !name.contains('sans')) return 'serif';
    if (RegExp(r'georgia|times|garamond|merriweather|playfair|lora|baskerville').hasMatch(name)) return 'serif';
    return null;
  }

  String _collectText(Element element) {
    final parts = <String>[];
    void walk(Element e) {
      final widget = e.widget;
      if (widget is TickerMode && !widget.enabled) return;
      if (widget is Offstage && widget.offstage) return;
      if (widget is Visibility && !widget.visible) return;
      if (widget is Icon) return;
      if (e is RenderObjectElement && e.renderObject is RenderIndexedStack) {
        final shown = (e.renderObject as RenderIndexedStack).index;
        var index = -1;
        e.visitChildren((child) {
          index += 1;
          if (index == shown) walk(child);
        });
        return;
      }
      if (e is RenderObjectElement) {
        final object = e.renderObject;
        if (object is RenderOpacity && object.opacity <= 0.004) return;
        if (object is RenderAnimatedOpacity && object.opacity.value <= 0.004) return;
      }
      if (widget is RichText) {
        final family = widget.text.style?.fontFamily;
        if (family == 'MaterialIcons' || family == 'CupertinoIcons') return;
        final text = widget.text.toPlainText(includeSemanticsLabels: false, includePlaceholders: false).trim();
        if (text.isNotEmpty) parts.add(text);
        return;
      }
      e.visitChildren(walk);
    }

    element.visitChildren(walk);
    return parts.join(' ');
  }

  // ----------------------------------------------------------------- fields --

  _Rec? _editable(Element element, EditableText widget, _Frame f) {
    final box = _boxOf(element);
    if (box == null) return null;
    final value = widget.controller.text;
    final field = f.field;
    if (field == null && widget.readOnly && !widget.obscureText) {
      // `SelectableText` is an EditableText that nobody types into: the app's
      // own words.
      final attributes = _textStyle(widget.style, widget.textScaler ?? TextScaler.noScaling, widget.textAlign,
          widget.textDirection ?? TextDirection.ltr);
      return _Rec('Text', box, attributes: attributes, text: value.trim().isEmpty ? null : value)
        ..masked = looksLikeCardNumber(value.trim());
    }

    final sensitive = isSensitiveField(FieldTraits(
      obscureText: widget.obscureText,
      autofillHints: widget.autofillHints ?? const [],
      visiblePasswordKeyboard: widget.keyboardType == TextInputType.visiblePassword,
      names: [field?.hint, field?.label, f.label, field?.keyName, field?.restorationId, _keyName(widget.key)],
    ));
    final attributes = <String, Object>{};
    final hint = field?.hint;
    if (hint != null && hint.isNotEmpty) attributes['placeholder'] = hint;
    final label = field?.label ?? f.label;
    if (label != null && label.isNotEmpty) attributes['aria-label'] = label;
    final colour = _colour(widget.style.color);
    if (colour != null) attributes['color'] = colour;
    final size = (widget.textScaler ?? TextScaler.noScaling).scale(widget.style.fontSize ?? 14);
    if (size.isFinite && size > 0) attributes['size'] = _number(size);
    if (field != null && !field.enabled) attributes['disabled'] = true;

    final rec = _Rec('TextInput', box, attributes: attributes, text: value.isEmpty ? null : value);
    rec.masked = sensitive || settings.maskAllInputs || settings.maskAllTyping || looksLikeCardNumber(value);
    return rec;
  }

  // ----------------------------------------------------------- icons, images --

  _Rec? _icon(Element element, Icon widget, _Frame f) {
    final data = widget.icon;
    if (data == null) return null;
    final box = _boxOf(element);
    if (box == null) return null;
    final named = namedIconFor(data.codePoint, data.fontFamily, data.fontPackage);
    final attributes = <String, Object>{
      if (named != null) 'iconSet': named.iconSet,
      if (named != null) 'glyph': named.name,
    };
    final colour = _colour(widget.color ?? _firstTextColour(element));
    if (colour != null) attributes['color'] = colour;
    final label = widget.semanticLabel;
    if (label != null && label.trim().isNotEmpty) attributes['aria-label'] = label;
    return _Rec('Icon', box, attributes: attributes)..takesLabel = true;
  }

  static Color? _firstTextColour(Element element) {
    Color? found;
    void walk(Element e) {
      if (found != null) return;
      final widget = e.widget;
      if (widget is RichText) {
        found = widget.text.style?.color;
        return;
      }
      e.visitChildren(walk);
    }

    element.visitChildren(walk);
    return found;
  }

  _Rec? _image(Element element, Image widget, _Frame f) {
    final box = _boxOf(element);
    if (box == null) return null;
    final masked = f.masked || settings.maskImages;
    final attributes = <String, Object>{};
    if (!masked) {
      var provider = widget.image;
      if (provider is ResizeImage) provider = provider.imageProvider;
      if (provider is NetworkImage) {
        final src = _httpUrl(provider.url);
        if (src != null) attributes['src'] = src;
      } else if (provider is AssetImage || provider is ExactAssetImage) {
        final key = provider is AssetImage ? provider.keyName : (provider as ExactAssetImage).keyName;
        final bundle = provider is AssetImage ? provider.bundle : (provider as ExactAssetImage).bundle;
        if (bundle == null) {
          final hash = settings.assetHash?.call(key);
          if (hash != null) attributes['asset'] = hash;
        }
      } else if (provider.runtimeType.toString().contains('Network')) {
        // cached_network_image and the like keep the address in `url`.
        try {
          final url = (provider as dynamic).url;
          if (url is String) {
            final src = _httpUrl(url);
            if (src != null) attributes['src'] = src;
          }
        } catch (_) {/* no url: a box without a picture */}
      }
    }
    final fit = switch (widget.fit) {
      BoxFit.contain || BoxFit.fitWidth || BoxFit.fitHeight => 'contain',
      BoxFit.fill => 'fill',
      BoxFit.none => 'none',
      BoxFit.scaleDown => 'scale-down',
      BoxFit.cover => 'cover',
      null => null,
    };
    if (fit != null) attributes['fit'] = fit;
    final alt = widget.semanticLabel;
    if (alt != null && alt.trim().isNotEmpty) attributes['alt'] = alt;
    return _Rec('Image', box, attributes: attributes)
      ..masked = settings.maskImages
      ..takesLabel = true;
  }

  static String? _httpUrl(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null || !(uri.isScheme('http') || uri.isScheme('https')) || uri.host.isEmpty) return null;
    return url.length <= 2048 ? url : null;
  }

  // ------------------------------------------------------------ decoration --

  _Rec? _decorated(RenderDecoratedBox object, Decoration decoration) {
    final attributes = <String, Object>{};
    final size = object.hasSize ? object.size : Size.zero;
    if (decoration is BoxDecoration) {
      final bg = _colour(decoration.color);
      if (bg != null) attributes['bg'] = bg;
      final gradient = decoration.gradient;
      if (gradient != null) _gradient(gradient, attributes);
      if (decoration.shape == BoxShape.circle) {
        _radius(size.shortestSide / 2, attributes);
      } else if (decoration.borderRadius != null) {
        _radius(decoration.borderRadius!.resolve(TextDirection.ltr).topLeft.x, attributes);
      }
      final border = decoration.border;
      if (border is Border && border.isUniform && border.top.style != BorderStyle.none && border.top.width > 0) {
        final colour = _colour(border.top.color);
        if (colour != null) {
          attributes['bw'] = _number(math.min(border.top.width, 100));
          attributes['bc'] = colour;
        }
      }
    } else if (decoration is ShapeDecoration) {
      final bg = _colour(decoration.color);
      if (bg != null) attributes['bg'] = bg;
      final gradient = decoration.gradient;
      if (gradient != null) _gradient(gradient, attributes);
      _shape(decoration.shape, size, attributes);
    } else {
      return null;
    }
    if (!attributes.containsKey('bg') && !attributes.containsKey('grad') && !attributes.containsKey('bc')) return null;
    return _Rec('View', object, attributes: attributes, leaf: false)
      ..decoration = true
      ..takesLabel = true;
  }

  _Rec? _physicalModel(RenderPhysicalModel object) {
    final bg = _colour(object.color);
    if (bg == null) return null;
    final attributes = <String, Object>{'bg': bg};
    if (object.shape == BoxShape.circle && object.hasSize) {
      _radius(object.size.shortestSide / 2, attributes);
    } else if (object.borderRadius != null) {
      _radius(object.borderRadius!.resolve(TextDirection.ltr).topLeft.x, attributes);
    }
    return _Rec('View', object, attributes: attributes, leaf: false)
      ..decoration = true
      ..takesLabel = true;
  }

  _Rec? _physicalShape(RenderPhysicalShape object) {
    final bg = _colour(object.color);
    if (bg == null) return null;
    final attributes = <String, Object>{'bg': bg};
    final clipper = object.clipper;
    if (clipper is ShapeBorderClipper) _shape(clipper.shape, object.hasSize ? object.size : Size.zero, attributes);
    return _Rec('View', object, attributes: attributes, leaf: false)
      ..decoration = true
      ..takesLabel = true;
  }

  void _shape(ShapeBorder shape, Size size, Map<String, Object> attributes) {
    if (shape is CircleBorder || shape is StadiumBorder) {
      _radius(size.shortestSide / 2, attributes);
    } else if (shape is RoundedRectangleBorder) {
      _radius(shape.borderRadius.resolve(TextDirection.ltr).topLeft.x, attributes);
    } else if (shape is ContinuousRectangleBorder) {
      _radius(shape.borderRadius.resolve(TextDirection.ltr).topLeft.x / 2, attributes);
    }
    if (shape is OutlinedBorder) {
      final side = shape.side;
      final colour = _colour(side.color);
      if (side.style != BorderStyle.none && side.width > 0 && colour != null) {
        attributes['bw'] = _number(math.min(side.width, 100));
        attributes['bc'] = colour;
      }
    }
  }

  static void _radius(double value, Map<String, Object> attributes) {
    if (!value.isFinite || value <= 0) return;
    attributes['r'] = _number(math.min(value, 1000));
  }

  static void _gradient(Gradient gradient, Map<String, Object> attributes) {
    final colours = gradient.colors;
    if (colours.length < 2) return;
    if (gradient is LinearGradient) {
      final begin = gradient.begin.resolve(TextDirection.ltr);
      final end = gradient.end.resolve(TextDirection.ltr);
      final count = math.min(colours.length, 12);
      final stops = gradient.stops;
      final parts = <String>[
        [(begin.x + 1) / 2, (begin.y + 1) / 2, (end.x + 1) / 2, (end.y + 1) / 2].map(_fixed).join(','),
      ];
      for (var i = 0; i < count; i += 1) {
        final colour = _colour(colours[i], keepTransparent: true);
        if (colour == null) return;
        final at = stops != null && i < stops.length ? stops[i] : (count == 1 ? 0.0 : i / (count - 1));
        parts.add('$colour@${_fixed(at.clamp(0.0, 1.0))}');
      }
      final encoded = parts.join('|');
      if (encoded.length <= 600) attributes['grad'] = encoded;
    } else {
      // Radial and sweep gradients have no encoding: their first colour.
      final bg = _colour(colours.first);
      if (bg != null) attributes.putIfAbsent('bg', () => bg);
    }
  }

  static String _fixed(double value) {
    final rounded = (value * 1000).round() / 1000;
    return rounded == rounded.roundToDouble() ? rounded.round().toString() : rounded.toString();
  }

  static num _number(double value) {
    final rounded = (value * 10).round() / 10;
    return rounded == rounded.roundToDouble() ? rounded.round() : rounded;
  }

  // --------------------------------------------------------------- painters --

  /// Whether type names can be read: an `--obfuscate` build renames every
  /// class, and then no painter can be told from the framework's.
  static final bool _namesReadable = const CustomPaint().runtimeType.toString() == 'CustomPaint';

  /// A `CustomPaint` the app drew itself — a chart, a signature, a game —
  /// rather than the framework's own borders, scrollbars, toggles and
  /// spinners, which are listed by name in framework_painters.g.dart.
  static bool _isAppPainter(CustomPaint widget) {
    if (!_namesReadable) return false;
    for (final painter in [widget.painter, widget.foregroundPainter]) {
      if (painter == null) continue;
      if (frameworkPainters.contains(painter.runtimeType.toString())) continue;
      return true;
    }
    return false;
  }

  static final Map<Type, String?> _libraryTags = {};

  /// Web views, maps and video players from the usual packages, by the name
  /// of their widget: opaque areas the recording never looks inside.
  static String? _libraryTag(Type type) {
    return _libraryTags.putIfAbsent(type, () {
      var name = type.toString();
      final generic = name.indexOf('<');
      if (generic > 0) name = name.substring(0, generic);
      const webViews = {
        'WebViewWidget',
        'WebView',
        'InAppWebView',
        'WebViewX',
        'PlatformWebViewWidget',
        'HtmlElementView'
      };
      const maps = {
        'GoogleMap',
        'FlutterMap',
        'MapWidget',
        'MaplibreMap',
        'MapboxMap',
        'AppleMap',
        'YandexMap',
        'HereMap',
        'MapLibreMap'
      };
      const videos = {
        'VideoPlayer',
        'Chewie',
        'BetterPlayer',
        'Video',
        'VlcPlayer',
        'YoutubePlayer',
        'YoutubePlayerIFrame',
        'CachedVideoPlayer'
      };
      if (webViews.contains(name)) return 'WebView';
      if (maps.contains(name)) return 'Map';
      if (videos.contains(name)) return 'Video';
      return null;
    });
  }
}

/// A colour literal the format accepts: `#rrggbb`, or `#rrggbbaa` when not
/// opaque. Null for a missing or fully transparent colour.
String? _colour(Color? colour, {bool keepTransparent = false}) {
  if (colour == null) return null;
  final argb = colour.toARGB32();
  final alpha = (argb >> 24) & 0xff;
  if (alpha == 0 && !keepTransparent) return null;
  final rgb = (argb & 0xffffff).toRadixString(16).padLeft(6, '0');
  return alpha == 0xff ? '#$rgb' : '#$rgb${alpha.toRadixString(16).padLeft(2, '0')}';
}
