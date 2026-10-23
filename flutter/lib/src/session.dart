import 'dart:async';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

/// Who is being recorded, and for how long (docs/SDK-CONTRACT.md §3).
///
/// The same rules, keys and numbers as the browser and React Native SDKs: a
/// visitor id that outlives sessions, a session that ends after 30 quiet
/// minutes, chunk numbers reserved before they are used, and a two-minute
/// pause after ingest says a quota is full.

/// A new session starts after this much inactivity.
const Duration sessionIdle = Duration(minutes: 30);
const int sessionIdleMs = 30 * 60 * 1000;

/// How long an app waits after a 402 before trying to record again.
const int quotaCooldownMs = 2 * 60 * 1000;

const String visitorKey = 'anyreplay.vid';
const String sessionKey = 'anyreplay.sid';
const String sessionTsKey = 'anyreplay.sts';
const String seqKey = 'anyreplay.seq';
const String cooldownKey = 'anyreplay.cd';

/// Every key a refusal of consent removes.
const List<String> allSessionKeys = [visitorKey, sessionKey, sessionTsKey, seqKey, cooldownKey];

/// A small asynchronous key-value store. The recorder keeps a handful of
/// short strings in it under `anyreplay.*`.
abstract class AnyReplayStore {
  Future<String?> getItem(String key);
  Future<void> setItem(String key, String value);
  Future<void> removeItem(String key);
}

/// Forgets everything when the process ends. For tests, and for an app that
/// wants no trace kept between launches (each launch is then a new visitor).
class MemoryStore implements AnyReplayStore {
  final Map<String, String> values = {};
  @override
  Future<String?> getItem(String key) async => values[key];
  @override
  Future<void> setItem(String key, String value) async => values[key] = value;
  @override
  Future<void> removeItem(String key) async => values.remove(key);
}

/// The default store: `shared_preferences` (UserDefaults on iOS; DataStore or
/// SharedPreferences on Android). Opened on first use, so nothing touches the
/// platform before the recorder is allowed to.
class SharedPreferencesStore implements AnyReplayStore {
  SharedPreferencesAsync? _prefs;
  SharedPreferencesAsync get _store => _prefs ??= SharedPreferencesAsync();

  @override
  Future<String?> getItem(String key) => _store.getString(key);
  @override
  Future<void> setItem(String key, String value) => _store.setString(key, value);
  @override
  Future<void> removeItem(String key) => _store.remove(key);
}

final Random _random = _secureRandom();

Random _secureRandom() {
  try {
    return Random.secure();
  } catch (_) {
    // No secure source on this platform: the ids are opaque identifiers, not
    // secrets, so an ordinary generator is an honest fallback.
    return Random();
  }
}

String _randomHex(int bytes) {
  final out = StringBuffer();
  for (var i = 0; i < bytes; i += 1) {
    out.write(_random.nextInt(256).toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

/// A lowercase UUID version 4, which is what ingest requires for a session id.
String uuidV4() {
  final hex = _randomHex(16).split('');
  hex[12] = '4';
  hex[16] = ((int.parse(hex[16], radix: 16) & 0x3) | 0x8).toRadixString(16);
  final s = hex.join();
  return '${s.substring(0, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${s.substring(16, 20)}-${s.substring(20)}';
}

/// `v` followed by 24 lowercase hex digits.
String newVisitorId() => 'v${_randomHex(12)}';

final RegExp visitorIdPattern = RegExp(r'^v[0-9a-f]{24}$');

class Identity {
  const Identity({required this.visitorId, required this.sessionId, required this.fresh, required this.nextSeq});
  final String visitorId;
  final String sessionId;

  /// True when this call started a new session rather than resuming one.
  final bool fresh;

  /// The chunk number to continue from: 0 for a new session.
  final int nextSeq;
}

/// The visitor and the session for this launch: the stored session when it
/// was active less than 30 minutes ago, a new one otherwise.
Future<Identity> resolveIdentity(AnyReplayStore store, int now) async {
  var visitorId = await store.getItem(visitorKey);
  if (visitorId == null || !visitorIdPattern.hasMatch(visitorId)) {
    visitorId = newVisitorId();
    await store.setItem(visitorKey, visitorId);
  }

  final sessionId = await store.getItem(sessionKey);
  final lastSeen = int.tryParse(await store.getItem(sessionTsKey) ?? '') ?? 0;
  final stillOpen = sessionId != null && sessionId.isNotEmpty && lastSeen > 0 && now - lastSeen < sessionIdleMs;

  if (stillOpen) {
    await store.setItem(sessionTsKey, '$now');
    // A relaunch inside the idle window resumes the numbering too: ingest
    // discards a repeated (session, seq) as a retry.
    final storedSeq = int.tryParse(await store.getItem(seqKey) ?? '') ?? 0;
    return Identity(visitorId: visitorId, sessionId: sessionId, fresh: false, nextSeq: storedSeq > 0 ? storedSeq : 0);
  }

  final next = uuidV4();
  await store.setItem(sessionKey, next);
  await store.setItem(sessionTsKey, '$now');
  await store.setItem(seqKey, '0');
  return Identity(visitorId: visitorId, sessionId: next, fresh: true, nextSeq: 0);
}

/// Starts a new session for a visitor who already has an id: the app came
/// back after the idle window. The writes are issued in order before this
/// returns, so a number reserved for the new session a moment later can never
/// be overwritten by the `0`.
Identity beginNewSession(AnyReplayStore store, String visitorId, int now) {
  final sessionId = uuidV4();
  unawaited(Future.wait([
    store.setItem(seqKey, '0'),
    store.setItem(sessionKey, sessionId),
    store.setItem(sessionTsKey, '$now'),
  ]).catchError((Object _) => <void>[]));
  return Identity(visitorId: visitorId, sessionId: sessionId, fresh: true, nextSeq: 0);
}

Future<bool> inCooldown(AnyReplayStore store, int now) async {
  final until = int.tryParse(await store.getItem(cooldownKey) ?? '');
  return until != null && until > now;
}

Future<void> startCooldown(AnyReplayStore store, int now) => store.setItem(cooldownKey, '${now + quotaCooldownMs}');

Future<void> reserveSeq(AnyReplayStore store, int next) => store.setItem(seqKey, '$next');

Future<void> touchSession(AnyReplayStore store, int now) => store.setItem(sessionTsKey, '$now');

/// Removes everything the recorder has stored on this device (a refusal of
/// consent undoes an earlier acceptance, not merely this launch).
Future<void> forgetVisitor(AnyReplayStore store) async {
  for (final key in allSessionKeys) {
    await store.removeItem(key);
  }
}

/// The native family's sampling hash (contract §3.4), bit for bit:
/// `hash = (hash * 31 + c) mod 2^32` over the UTF-16 code units, then
/// `(hash mod 10000) / 10000.0 < rate`.
///
/// Masked to 32 bits after every step, so the answer is the same on the web
/// (where Dart's `int` is a double) as on a phone.
int samplingBucket(String visitorId) {
  var hash = 0;
  for (final unit in visitorId.codeUnits) {
    hash = ((hash * 31) & 0xffffffff) + unit;
    hash &= 0xffffffff;
  }
  return hash % 10000;
}

bool isSampledIn(String visitorId, double rate) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return samplingBucket(visitorId) / 10000.0 < rate;
}
