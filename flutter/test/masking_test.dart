import 'dart:convert';
import 'dart:io';

import 'package:anyreplay_flutter/src/masking.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// The masking floor (contract §6.1), one platform hint at a time: the wire
/// cannot show which hint a field had, so this is where each is proven.
void main() {
  group('the floor', () {
    test('obscureText', () {
      expect(isSensitiveField(const FieldTraits(obscureText: true)), isTrue);
    });

    test('the visible-password keyboard', () {
      expect(isSensitiveField(const FieldTraits(visiblePasswordKeyboard: true)), isTrue);
    });

    test('every credential, one-time-code and payment autofill hint', () {
      const hints = [
        AutofillHints.password, AutofillHints.newPassword, AutofillHints.oneTimeCode,
        AutofillHints.creditCardNumber, AutofillHints.creditCardSecurityCode,
        AutofillHints.creditCardExpirationDate, AutofillHints.creditCardExpirationMonth,
        AutofillHints.creditCardExpirationYear, AutofillHints.creditCardExpirationDay,
        AutofillHints.creditCardName, AutofillHints.creditCardGivenName, AutofillHints.creditCardMiddleName,
        AutofillHints.creditCardFamilyName, AutofillHints.creditCardType,
        'creditCardExpiration', 'smsOTPCode',
        // Web-shaped tokens passed straight through.
        'cc-number', 'cc-csc', 'one-time-code', 'current-password',
      ];
      for (final hint in hints) {
        expect(isSensitiveField(FieldTraits(autofillHints: [hint])), isTrue, reason: hint);
      }
    });

    test('contact details are not in the floor', () {
      const hints = [
        AutofillHints.email,
        AutofillHints.telephoneNumber,
        AutofillHints.postalCode,
        AutofillHints.username,
        AutofillHints.name,
        AutofillHints.fullStreetAddress,
      ];
      for (final hint in hints) {
        expect(isSensitiveField(FieldTraits(autofillHints: [hint])), isFalse, reason: hint);
      }
      expect(isSensitiveField(const FieldTraits()), isFalse);
    });

    test('fields named like a credential or a payment instrument', () {
      for (final name in [
        'Password',
        'Şifre (password)',
        'passwd',
        'passphrase',
        'pwd',
        'OTP',
        'one-time code',
        'Card number',
        'credit card',
        'CVV',
        'cvc',
        'Security code',
        'IBAN',
        'routing number',
        'sort code',
        'cc-exp',
      ]) {
        expect(isSensitiveField(FieldTraits(names: [name])), isTrue, reason: name);
      }
    });

    test('and not words that merely contain the letters', () {
      for (final name in [
        'discard',
        'scoreboard',
        'accounting',
        'Kupon kodu',
        'E-posta',
        'Adres',
        'Cardigan size',
        'topt'
      ]) {
        expect(isSensitiveField(FieldTraits(names: [name])), isFalse, reason: name);
      }
    });
  });

  group('card numbers', () {
    test('Luhn-valid, 13 to 19 digits, spaces and dashes allowed', () {
      expect(looksLikeCardNumber('4242424242424242'), isTrue);
      expect(looksLikeCardNumber('4242 4242 4242 4242'), isTrue);
      expect(looksLikeCardNumber('4111-1111-1111-1111'), isTrue);
      expect(looksLikeCardNumber('378282246310005'), isTrue);
    });

    test('not a failing checksum, a short number or text around it', () {
      expect(looksLikeCardNumber('4242424242424241'), isFalse);
      expect(looksLikeCardNumber('424242424242'), isFalse);
      expect(looksLikeCardNumber('card 4242424242424242'), isFalse);
      expect(looksLikeCardNumber(' 4242424242424242'), isFalse);
      expect(looksLikeCardNumber('42424242424242424242'), isFalse);
    });
  });

  group('a card number being typed', () {
    test('the shared vectors', () {
      final file = File('../shared/test-fixtures/conformance/card-typing-vectors.json');
      if (!file.existsSync()) {
        markTestSkipped('the vectors live in the AnyReplay monorepo');
        return;
      }
      final vectors = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
      for (final value in (vectors['masked']! as List).cast<String>()) {
        expect(mayBecomeCardNumber(value), isTrue, reason: value);
      }
      for (final value in (vectors['unmasked']! as List).cast<String>()) {
        expect(mayBecomeCardNumber(value), isFalse, reason: value);
      }
    });

    test('the same cases without the file', () {
      for (final value in ['4242424', '4242 4242 4', '5555-5555-5', '3782 822463 10005']) {
        expect(mayBecomeCardNumber(value), isTrue, reason: value);
      }
      for (final value in ['424242', '05321234567', '415-555-0100', '2026-09-18', '1234567890123', '42 4242 4242']) {
        expect(mayBecomeCardNumber(value), isFalse, reason: value);
      }
    });
  });

  group('a card number inside longer text', () {
    final file = File('../shared/test-fixtures/conformance/card-run-vectors.json');
    final vectors = file.existsSync() ? jsonDecode(file.readAsStringSync()) as Map<String, Object?> : null;

    test('the shared cases', () {
      if (vectors == null) return markTestSkipped('the vectors live in the AnyReplay monorepo');
      for (final c in (vectors['cases']! as List).cast<Map<String, Object?>>()) {
        expect(maskCardRuns(c['text']! as String), c['recorded'], reason: c['text']! as String);
      }
    });

    test('typed one character at a time, never more than six of its digits and never a different length', () {
      if (vectors == null) return markTestSkipped('the vectors live in the AnyReplay monorepo');
      for (final whole in (vectors['typed']! as List).cast<String>()) {
        final cards = RegExp('[0-9]+(?:[ -][0-9]+)*')
            .allMatches(whole)
            .map((m) => m[0]!)
            .where((run) => run.replaceAll(RegExp('[ -]'), '').length >= 13)
            .toList();
        for (var n = 1; n <= whole.length; n += 1) {
          final typed = whole.substring(0, n);
          final recorded = maskCardRuns(typed);
          expect(recorded.length, typed.length, reason: typed);
          for (final card in cards) {
            final digits = card.replaceAll(RegExp('[ -]'), '');
            expect(recorded.replaceAll(RegExp('[ -]'), ''), isNot(contains(digits.substring(0, 7))), reason: typed);
          }
        }
      }
    });

    test('the same cases without the file', () {
      expect(maskCardRuns('Hunter2 4242 4242 4242 4242'), 'Hunter2 **** **** **** ****');
      expect(maskCardRuns('4242424242424242 12345'), '**************** 12345');
      expect(maskCardRuns('pay 4242 4242 4242 4242 now'), 'pay **** **** **** **** now');
      expect(maskCardRuns('card 4242 4242 4242 4242'), 'card **** **** **** ****');
      for (final text in ['Call me on 0532 123 45 67', 'due 2026-10-08', 'Row 3 — item #1003', 'order 1000234567']) {
        expect(maskCardRuns(text), text);
      }
    });
  });

  test('the patterns are byte for byte the checker\'s', () {
    final file = File('../shared/src/conformance/masking.ts');
    if (!file.existsSync()) {
      markTestSkipped('masking.ts lives in the AnyReplay monorepo');
      return;
    }
    final source = file.readAsStringSync();
    // PAYMENT_FIELD is written as concatenated strings with doubled
    // backslashes; put it back together and compare.
    final payment = RegExp(r"PAYMENT_FIELD = new RegExp\(\s*([\s\S]*?),\s*'i',").firstMatch(source)!.group(1)!;
    final joined =
        RegExp(r"'((?:[^'\\]|\\.)*)'").allMatches(payment).map((m) => m.group(1)!.replaceAll(r'\\', r'\')).join();
    expect(paymentField.pattern, joined);
    final credential = RegExp(r'CREDENTIAL_FIELD = /(.*)/i;').firstMatch(source)!.group(1)!;
    expect(credentialField.pattern, credential);
  });
}
