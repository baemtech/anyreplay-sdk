import 'package:anyreplay_flutter/src/events.dart';
import 'package:flutter_test/flutter_test.dart';

class _Thing {
  @override
  String toString() => 'a thing';
}

void main() {
  group('track', () {
    test('takes a name and a map, and copies the map', () {
      final props = <String, Object?>{
        'cart': 3,
        'nested': {
          'a': [1, 2]
        }
      };
      final payload = validateTrack('checkout_started', props) as TrackPayload;
      props['cart'] = 4;
      expect(payload.toJson(), {
        'name': 'checkout_started',
        'properties': {
          'cart': 3,
          'nested': {
            'a': [1, 2]
          }
        },
      });
    });

    test('no properties is an empty map', () {
      expect((validateTrack('a', null) as TrackPayload).properties, isEmpty);
    });

    test('refuses bad names, never throws', () {
      for (final name in ['', r'$navigate', 'has space', 'x' * 65, 'ö']) {
        expect(validateTrack(name, null), isA<String>(), reason: name);
      }
      expect(validateTrack(null, null), isA<String>());
      expect(validateTrack('a:b.c-d_e', null), isA<TrackPayload>());
    });

    test('refuses properties that are not JSON, or over 4 KB', () {
      expect(validateTrack('a', {'x': _Thing()}), isA<String>());
      expect(validateTrack('a', {'x': 'y' * 5000}), isA<String>());
      expect(validateTrack('a', {'x': 'ğ' * 2100}), isA<String>(), reason: 'counted in UTF-8 bytes');
      expect(validateTrack('a', {'x': 'y' * 4000}), isA<TrackPayload>());
    });
  });

  group('redaction', () {
    test('takes out addresses, card numbers and tokens, in that order', () {
      expect(redactText('mail ali@example.com now'), 'mail [redacted] now');
      expect(redactText('kart 4242 4242 4242 4242 reddedildi'), 'kart [redacted] reddedildi');
      expect(redactText('kart 4242-4242-4242-4242'), 'kart [redacted]');
      expect(redactText('token eyJhbGciOiJIUzI1NiJ9abcdef123456 x'), 'token [redacted] x');
    });

    test('leaves order numbers and ordinary words', () {
      expect(redactText('sipariş 1234567890123 hazır'), 'sipariş 1234567890123 hazır');
      expect(redactText('Kupon doğrulanamadı'), 'Kupon doğrulanamadı');
      expect(redactText('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopqrstuvwxyz', reason: 'no digit, not a token');
    });
  });

  group('error payloads', () {
    test('message, name, stack and kind, redacted', () {
      final payload = errorPayload(ErrorKind.error, StateError('no user ali@example.com'),
          stack: StackTrace.fromString('#0 main (file.dart:1)'));
      expect(payload['message'], 'Bad state: no user [redacted]');
      expect(payload['name'], 'StateError');
      expect(payload['stack'], '#0 main (file.dart:1)');
      expect(payload['kind'], 'error');
      expect(payload.keys, ['message', 'name', 'stack', 'kind']);
    });

    test('names implementation types as people write them', () {
      expect(errorPayload(ErrorKind.error, Exception('x'))['name'], 'Exception');
      expect(errorPayload(ErrorKind.error, Exception('x'))['message'], 'Exception: x');
    });

    test('a string is its own message, with no name', () {
      final payload = errorPayload(ErrorKind.rejection, 'went wrong');
      expect(payload, {'message': 'went wrong', 'kind': 'rejection'});
    });

    test('clips the message to 1000 and the stack to 4000 characters', () {
      final payload = errorPayload(ErrorKind.fatal, 'x' * 1200, stack: StackTrace.fromString('y' * 5000));
      expect(payload['message'], '${'x' * 1000}…');
      expect(payload['stack'], '${'y' * 4000}…');
    });

    test('is never empty', () {
      expect(errorPayload(ErrorKind.error, '')['message'], 'error');
      expect(errorPayload(ErrorKind.error, null)['message'], 'null');
    });
  });
}
