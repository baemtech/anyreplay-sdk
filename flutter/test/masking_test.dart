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
