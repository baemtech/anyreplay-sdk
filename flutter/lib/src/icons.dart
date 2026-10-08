import 'icon_names.g.dart';

/// Icons by name (docs/MOBILE-REPLAY-FORMAT.md §10).
///
/// A running app only knows an icon's code point and font. The dashboard
/// draws named icons with the Material Icons font, whose code points differ
/// from Flutter's bundled `MaterialIcons`, so the recording carries the
/// icon's name: `iconSet: 'material'`, `glyph: 'shopping_cart'`. The table
/// is generated from the Flutter SDK by tool/generate_tables.dart.
///
/// `Icons.favorite_outlined`, `_rounded` and `_sharp` share their icon's name;
/// the dashboard draws the filled one. CupertinoIcons are recorded as
/// `iconSet: 'sf'` with their name's underscores as dots (`heart_fill` →
/// `heart.fill`), which the dashboard maps to Material where it can.

class NamedIcon {
  const NamedIcon(this.iconSet, this.name);
  final String iconSet;
  final String name;
}

Map<int, String>? _material;
Map<int, String>? _cupertino;

Map<int, String> _unpack(String packed) {
  final map = <int, String>{};
  for (final entry in packed.split(';')) {
    final colon = entry.indexOf(':');
    if (colon <= 0) continue;
    final name = entry.substring(0, colon);
    for (final point in entry.substring(colon + 1).split(',')) {
      final code = int.tryParse(point, radix: 16);
      if (code != null) map[code] = name;
    }
  }
  return map;
}

/// The recorded name of the icon drawn with [codePoint] in [fontFamily], or
/// null for a font the dashboard cannot draw (an app's own icon font).
///
/// Takes the code point and font rather than an `IconData`: building an
/// `IconData` at run time would stop the app's release build from
/// tree-shaking its icon fonts.
NamedIcon? namedIconFor(int codePoint, String? fontFamily, [String? fontPackage]) {
  if (fontFamily == 'MaterialIcons' && fontPackage == null) {
    final name = (_material ??= _unpack(packedMaterialIcons))[codePoint];
    return name == null ? null : NamedIcon('material', name);
  }
  if (fontFamily == 'CupertinoIcons') {
    final name = (_cupertino ??= _unpack(packedCupertinoIcons))[codePoint];
    return name == null ? null : NamedIcon('sf', name.replaceAll('_', '.'));
  }
  return null;
}
