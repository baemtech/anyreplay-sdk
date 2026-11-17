import 'package:anyreplay_flutter/src/session.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const t0 = 1760000000000;

  group('identity', () {
    test('a first launch makes a visitor and a session, numbered from 0', () async {
      final store = MemoryStore();
      final who = await resolveIdentity(store, t0);
      expect(who.visitorId, matches(RegExp(r'^v[0-9a-f]{24}$')));
      expect(who.sessionId, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
      expect(who.fresh, isTrue);
      expect(who.nextSeq, 0);
      expect(store.values[visitorKey], who.visitorId);
      expect(store.values[sessionKey], who.sessionId);
      expect(store.values[seqKey], '0');
    });

    test('a relaunch within 30 minutes resumes the session and its numbering', () async {
      final store = MemoryStore();
      final first = await resolveIdentity(store, t0);
      await reserveSeq(store, 7);
      final again = await resolveIdentity(store, t0 + sessionIdleMs - 1);
      expect(again.visitorId, first.visitorId);
      expect(again.sessionId, first.sessionId);
      expect(again.fresh, isFalse);
      expect(again.nextSeq, 7);
    });

    test('at exactly 30 idle minutes the session has ended', () async {
      final store = MemoryStore();
      final first = await resolveIdentity(store, t0);
      final again = await resolveIdentity(store, t0 + sessionIdleMs);
      expect(again.visitorId, first.visitorId);
      expect(again.sessionId, isNot(first.sessionId));
      expect(again.nextSeq, 0);
    });

    test('a stored visitor id of the wrong shape is replaced', () async {
      final store = MemoryStore()..values[visitorKey] = 'not-an-id';
      final who = await resolveIdentity(store, t0);
      expect(who.visitorId, matches(RegExp(r'^v[0-9a-f]{24}$')));
    });

    test('a new session after a long absence keeps the visitor', () async {
      final store = MemoryStore();
      final first = await resolveIdentity(store, t0);
      await reserveSeq(store, 12);
      final next = beginNewSession(store, first.visitorId, t0 + 2 * sessionIdleMs);
      await Future<void>.delayed(Duration.zero);
      expect(next.visitorId, first.visitorId);
      expect(next.sessionId, isNot(first.sessionId));
      expect(store.values[seqKey], '0');
      expect(store.values[sessionKey], next.sessionId);
    });

    test('ids are lowercase, unique and of the right shape', () {
      final ids = {for (var i = 0; i < 500; i += 1) uuidV4()};
      expect(ids, hasLength(500));
      for (final id in ids) {
        expect(id, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
      }
      expect(newVisitorId(), matches(visitorIdPattern));
    });
  });

  group('cool-down after a 402', () {
    test('holds for two minutes, across launches', () async {
      final store = MemoryStore();
      expect(await inCooldown(store, t0), isFalse);
      await startCooldown(store, t0);
      expect(store.values[cooldownKey], '${t0 + quotaCooldownMs}');
      expect(await inCooldown(store, t0 + quotaCooldownMs - 1), isTrue);
      expect(await inCooldown(store, t0 + quotaCooldownMs), isFalse);
    });
  });

  group('forgetting', () {
    test('removes every key the contract names', () async {
      final store = MemoryStore();
      await resolveIdentity(store, t0);
      await startCooldown(store, t0);
      await reserveSeq(store, 3);
      store.values['other.app.key'] = 'kept';
      await forgetVisitor(store);
      for (final key in ['anyreplay.vid', 'anyreplay.sid', 'anyreplay.sts', 'anyreplay.seq', 'anyreplay.cd']) {
        expect(store.values.containsKey(key), isFalse, reason: key);
      }
      expect(store.values['other.app.key'], 'kept');
    });

    test('stores nothing when there was nothing', () async {
      final store = MemoryStore();
      await forgetVisitor(store);
      expect(store.values, isEmpty);
    });
  });

  group('sampling', () {
    test('everyone at 1, no one at 0', () {
      expect(isSampledIn('v000000000000000000000000', 1), isTrue);
      expect(isSampledIn('v000000000000000000000000', 0), isFalse);
    });

    test('the hash is the native family\'s, 32-bit', () {
      // From sampling-vectors.json.
      expect(samplingBucket('v000000000000000000000000'), 2662);
      expect(isSampledIn('v000000000000000000000000', 0.2662), isFalse);
      expect(isSampledIn('v000000000000000000000000', 0.2663), isTrue);
    });
  });
}
