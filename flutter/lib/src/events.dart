import 'dart:convert';

import 'masking.dart' show luhnValid;

/// Custom events: the moments an app tags and the errors it throws
/// (docs/SDK-CONTRACT.md §8). The tags and rules are the browser SDK's and
/// the React Native SDK's, so an app's `track('checkout_started')` and a
/// page's are the same row by the time anyone looks at them.

const String trackTag = 'anyreplay.track';
const String errorTag = 'anyreplay.error';
const String consoleTag = 'anyreplay.console';

final RegExp eventNamePattern = RegExp(r'^[A-Za-z0-9_.:-]{1,64}$');
const int maxPropertiesBytes = 4 * 1024;

/// Per-launch ceilings, as in the browser: a render loop must not fill a recording.
const int maxErrorsPerLaunch = 100;

const int _maxMessage = 1000;
const int _maxStack = 4000;

class TrackPayload {
  TrackPayload(this.name, this.properties);
  final String name;
  final Map<String, Object?> properties;
  Map<String, Object?> toJson() => {'name': name, 'properties': properties};
}

/// Checks what the app passed to `track()`: the payload to send, or the
/// reason it was refused as a [String]. Never throws.
Object validateTrack(Object? name, Object? properties) {
  if (name is! String || !eventNamePattern.hasMatch(name)) {
    return 'event name must be 1-64 characters of [A-Za-z0-9_.:-], got ${jsonEncodeSafe(name)}';
  }
  if (properties == null) return TrackPayload(name, <String, Object?>{});
  if (properties is! Map) return 'properties for "$name" must be a map';
  String serialised;
  try {
    serialised = jsonEncode(properties);
  } catch (_) {
    return 'properties for "$name" are not JSON-serialisable';
  }
  if (utf8.encode(serialised).length > maxPropertiesBytes) {
    return 'properties for "$name" exceed $maxPropertiesBytes bytes once serialised';
  }
  final decoded = jsonDecode(serialised);
  if (decoded is! Map<String, Object?>) return 'properties for "$name" must be a map with string keys';
  // The decoded copy: a later change to the app's map cannot change what was tracked.
  return TrackPayload(name, decoded);
}

String jsonEncodeSafe(Object? value) {
  try {
    return jsonEncode(value);
  } catch (_) {
    return '$value';
  }
}

/* ----------------------------------------------------------- redaction -- */

final RegExp _email = RegExp(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}');
final RegExp _opaque = RegExp(r'\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b');
final RegExp _digits = RegExp(r'\b[0-9][0-9 -]{11,22}[0-9]\b');

const String redacted = '[redacted]';

bool _cardShaped(String text) {
  final digits = text.replaceAll(RegExp(r'[ -]'), '');
  if (digits.length < 13 || digits.length > 19) return false;
  return luhnValid(digits);
}

/// Takes e-mail addresses, card numbers and long tokens out of free text,
/// in that order (contract §6.6). `redactText` of the React Native SDK.
String redactText(String text) {
  return text
      .replaceAll(_email, redacted)
      .replaceAllMapped(_digits, (m) => _cardShaped(m[0]!.trim()) ? redacted : m[0]!)
      .replaceAll(_opaque, redacted);
}

String _clip(String text, int max) => text.length > max ? '${text.substring(0, max)}…' : text;

/// `error` (handled or uncaught, not fatal), `fatal` or `rejection`.
enum ErrorKind { error, fatal, rejection }

/// The type of a thrown value, as people would write it: `_Exception` and
/// `_TypeError` are implementation names for `Exception` and `TypeError`.
String errorName(Object error) {
  final name = error.runtimeType.toString();
  return name.startsWith('_') ? name.substring(1) : name;
}

/// The `anyreplay.error` payload for [error], redacted and clipped.
Map<String, Object?> errorPayload(ErrorKind kind, Object? error, {StackTrace? stack, String? message}) {
  final text = message ?? _describe(error);
  final payload = <String, Object?>{
    'message': _clip(redactText(text).isEmpty ? 'error' : redactText(text), _maxMessage),
    'kind': kind.name,
  };
  if (error != null && error is! String) payload['name'] = errorName(error);
  final trace = stack?.toString() ?? (error is Error ? error.stackTrace?.toString() : null);
  if (trace != null && trace.trim().isNotEmpty) payload['stack'] = _clip(redactText(trace), _maxStack);
  // Keep the key order the other SDKs send: message, name, stack, kind.
  return {
    'message': payload['message'],
    if (payload.containsKey('name')) 'name': payload['name'],
    if (payload.containsKey('stack')) 'stack': payload['stack'],
    'kind': payload['kind'],
  };
}

String _describe(Object? value) {
  if (value == null) return 'null';
  if (value is String) return value;
  try {
    final text = value.toString();
    return text.isEmpty ? errorName(value) : text;
  } catch (_) {
    return errorName(value);
  }
}
