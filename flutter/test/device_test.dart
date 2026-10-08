import 'package:anyreplay_flutter/src/device.dart';
import 'package:anyreplay_flutter/src/icons.dart';
import 'package:anyreplay_flutter/src/navigation.dart';
import 'package:anyreplay_flutter/src/options.dart';
import 'package:anyreplay_flutter/src/session.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A copy of ingest's `parseUserAgent` (packages/shared/src/conformance/user-agent.ts
/// `classifyUserAgent`), so the agent string is checked against the reader
/// that files sessions by OS and device.
({String? os, String device}) classify(String ua) {
  final s = ua.toLowerCase();
  final os = s.contains('windows')
      ? 'Windows'
      : s.contains('android')
          ? 'Android'
          : s.contains('iphone') || s.contains('ipad') || s.contains('ios')
              ? 'iOS'
              : s.contains('mac os') || s.contains('macintosh')
                  ? 'macOS'
                  : s.contains('linux')
                      ? 'Linux'
                      : null;
  final device = s.contains('ipad') || (s.contains('android') && !s.contains('mobile'))
      ? 'tablet'
      : s.contains('mobile') || s.contains('iphone') || s.contains('android')
          ? 'mobile'
          : 'desktop';
  return (os: os, device: device);
}

void main() {
  group('the agent string (contract §2.6)', () {
    final cases = <(DeviceDescription, String, String, String)>[
      (
        const DeviceDescription(os: 'ios', osVersion: '18.0', model: 'iPhone15,2'),
        'AnyReplayFlutter/0.1 (iPhone; iOS 18.0; iPhone15,2) Mobile',
        'iOS',
        'mobile'
      ),
      (
        const DeviceDescription(os: 'ios', osVersion: '17.4', model: 'iPad13,1', tablet: true),
        'AnyReplayFlutter/0.1 (iPad; iOS 17.4; iPad13,1) Tablet',
        'iOS',
        'tablet'
      ),
      (
        const DeviceDescription(os: 'ios', osVersion: '17.4', model: 'arm64'),
        'AnyReplayFlutter/0.1 (iPhone; iOS 17.4) Mobile',
        'iOS',
        'mobile'
      ),
      (
        const DeviceDescription(os: 'android', osVersion: '14', model: 'Pixel 8'),
        'AnyReplayFlutter/0.1 (Android 14; Pixel 8) Mobile',
        'Android',
        'mobile'
      ),
      (
        const DeviceDescription(os: 'android', osVersion: '14', model: 'SM-X710', tablet: true),
        'AnyReplayFlutter/0.1 (Android 14; SM-X710) Tablet',
        'Android',
        'tablet'
      ),
      (
        const DeviceDescription(os: 'android', osVersion: '13', model: 'Galaxy Tab Mobile 10', tablet: true),
        'AnyReplayFlutter/0.1 (Android 13) Tablet',
        'Android',
        'tablet'
      ),
      (
        const DeviceDescription(os: 'android', osVersion: '12', model: 'X (Pro); 5G'),
        'AnyReplayFlutter/0.1 (Android 12; X Pro 5G) Mobile',
        'Android',
        'mobile'
      ),
    ];
    for (final (device, expected, os, kind) in cases) {
      test(expected, () {
        final ua = flutterUserAgent(device, '0.1.0');
        expect(ua, expected);
        expect(classify(ua), (os: os, device: kind));
        expect(
            RegExp(r'^AnyReplay[A-Za-z]+/[0-9]+\.[0-9]+ \([^()]+\)( (Mobile|Tablet|Desktop))?$').hasMatch(ua), isTrue);
      });
    }

    test('only major.minor of the SDK, whatever the pre-release', () {
      expect(flutterUserAgent(const DeviceDescription(os: 'android', osVersion: '14'), '1.12.3-beta.1'),
          startsWith('AnyReplayFlutter/1.12 '));
    });

    test('iOS reports its number without the build', () {
      expect(plainVersion('Version 17.4 (Build 21E213)'), '17.4');
      expect(plainVersion('14'), '14');
    });
  });

  group('options', () {
    test('a key from the dashboard, or nothing', () {
      for (final key in [
        '',
        'ar_pk_live_123',
        'ar_sk_live_0123456789abcdef01234567',
        'ar_pk_live_0123456789ABCDEF01234567'
      ]) {
        expect(() => ResolvedOptions.resolve(AnyReplayOptions(projectKey: key)), throwsA(isA<AnyReplayConfigError>()),
            reason: key);
      }
      final ok = ResolvedOptions.resolve(const AnyReplayOptions(projectKey: 'ar_pk_test_0123456789abcdef01234567'));
      expect(ok.ingestUrl, 'https://in.anyreplay.com');
    });

    test('the app id and version are read from the app unless given', () {
      final read = ResolvedOptions.resolve(const AnyReplayOptions(projectKey: 'ar_pk_live_0123456789abcdef01234567'),
          platformAppId: 'com.example.shop', platformAppVersion: '3.4.1');
      expect((read.appId, read.appVersion), ('com.example.shop', '3.4.1'));
      final given = ResolvedOptions.resolve(
          const AnyReplayOptions(
              projectKey: 'ar_pk_live_0123456789abcdef01234567', appId: 'com.other', appVersion: '9'),
          platformAppId: 'com.example.shop',
          platformAppVersion: '3.4.1');
      expect((given.appId, given.appVersion), ('com.other', '9'));
      expect(
          () => ResolvedOptions.resolve(
              const AnyReplayOptions(projectKey: 'ar_pk_live_0123456789abcdef01234567', appId: 'bad id')),
          throwsA(isA<AnyReplayConfigError>()));
    });

    test('ranges', () {
      const key = 'ar_pk_live_0123456789abcdef01234567';
      expect(() => ResolvedOptions.resolve(const AnyReplayOptions(projectKey: key, sampleRate: 1.5)),
          throwsA(isA<AnyReplayConfigError>()));
      expect(
          () => ResolvedOptions.resolve(
              const AnyReplayOptions(projectKey: key, snapshotInterval: Duration(milliseconds: 50))),
          throwsA(isA<AnyReplayConfigError>()));
      expect(() => ResolvedOptions.resolve(const AnyReplayOptions(projectKey: key, maxSessionsPerMonth: 0)),
          throwsA(isA<AnyReplayConfigError>()));
      expect(() => ResolvedOptions.resolve(const AnyReplayOptions(projectKey: key, ingestUrl: 'ftp://x')),
          throwsA(isA<AnyReplayConfigError>()));
      expect(
          ResolvedOptions.resolve(const AnyReplayOptions(projectKey: key, ingestUrl: 'http://localhost:4000//'))
              .ingestUrl,
          'http://localhost:4000');
    });

    test('masking options are off unless set, and the store is shared_preferences by default', () {
      final o = ResolvedOptions.resolve(const AnyReplayOptions(projectKey: 'ar_pk_live_0123456789abcdef01234567'));
      expect((o.maskAllInputs, o.maskAllTyping, o.maskImages, o.recordErrors, o.requireConsent),
          (false, false, false, true, false));
      expect(o.source.storage, isNull);
      expect(SharedPreferencesStore(), isA<AnyReplayStore>());
    });
  });

  group('icons by name', () {
    test('Material icons, every style of one icon under its name', () {
      for (final (icon, name) in [
        (Icons.favorite, 'favorite'),
        (Icons.favorite_border, 'favorite_border'),
        (Icons.arrow_back, 'arrow_back'),
        (Icons.shopping_cart_outlined, 'shopping_cart'),
        (Icons.ten_k, '10k'),
        (Icons.class_, 'class'),
        (Icons.home_rounded, 'home'),
        (Icons.delete_sharp, 'delete'),
      ]) {
        final named = namedIconFor(icon.codePoint, icon.fontFamily, icon.fontPackage);
        expect(named?.iconSet, 'material', reason: name);
        expect(named?.name, name);
      }
    });

    test('Cupertino icons as SF Symbol names', () {
      final named = namedIconFor(CupertinoIcons.heart_fill.codePoint, CupertinoIcons.heart_fill.fontFamily,
          CupertinoIcons.heart_fill.fontPackage);
      expect((named?.iconSet, named?.name), ('sf', 'heart.fill'));
    });

    test('an app\'s own icon font has no name', () {
      expect(namedIconFor(0xe000, 'MyIcons'), isNull);
      expect(namedIconFor(0x1, 'MaterialIcons'), isNull);
    });
  });

  group('screen names', () {
    test('without query or fragment', () {
      expect(screenName('/orders?id=829461'), '/orders');
      expect(screenName('/help#faq'), '/help');
      expect(screenName('Checkout'), 'Checkout');
      expect(screenName(''), isNull);
      expect(screenName('?x=1'), isNull);
      expect(screenName(null), isNull);
    });
  });

  test('sessionIdle is thirty minutes', () => expect(sessionIdle, const Duration(minutes: 30)));
}
