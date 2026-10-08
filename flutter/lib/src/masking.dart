/// What a recording may contain, and what it may never contain
/// (docs/SDK-CONTRACT.md §6).
///
/// Out of the box a recording keeps what a person types into a text field:
/// that is what makes a replay of a checkout nobody could finish worth
/// watching. `maskAllInputs` and `maskAllTyping` turn that off, and under
/// both sits a floor no option lifts: secure entry, credential, one-time-code
/// and payment fields, and anything shaped like a card number.
library;

/// The text a masked element's words and accessible name become: six U+2022.
const String maskText = '••••••';

/// `AutofillHints` values that name a credential, a one-time code or a
/// payment instrument: the iOS `textContentType` and Android autofill names
/// of contract §6.1, which is what Flutter's `AutofillHints` constants are.
///
/// Absent on purpose: postal codes, e-mail addresses, phone numbers and user
/// names are contact details, and masking them makes a checkout replay useless.
const Set<String> sensitiveAutofillHints = {
  'password',
  'newPassword',
  'oneTimeCode',
  'smsOTPCode',
  'creditCardNumber',
  'creditCardSecurityCode',
  'creditCardExpiration',
  'creditCardExpirationDate',
  'creditCardExpirationMonth',
  'creditCardExpirationYear',
  'creditCardExpirationDay',
  'creditCardName',
  'creditCardGivenName',
  'creditCardMiddleName',
  'creditCardFamilyName',
  'creditCardType',
};

/// How a payment field is named. Byte for byte the released SDKs' pattern
/// (`PAYMENT_FIELD` in packages/shared/src/conformance/masking.ts).
final RegExp paymentField = RegExp(
  r'(?:credit|debit|payment)[\s_-]*card'
  r'|card[\s_-]*(?:number|num|no|nr|code|pin|cvv|cvc|csc)'
  r'|(?:^|[^a-z])cc[\s_-]*(?:number|num|no|nr|csc|cvv|cvc|exp)'
  r'|(?:^|[^a-z])(?:cvv|cvc|cvn|csc)(?:[^a-z]|$)'
  r'|security[\s_-]*code'
  r'|(?:^|[^a-z])iban(?:[^a-z]|$)'
  r'|routing[\s_-]*number'
  r'|sort[\s_-]*code',
  caseSensitive: false,
);

/// How a credential field is named. `CREDENTIAL_FIELD`, byte for byte.
final RegExp credentialField = RegExp(
  r'pass(?:word|wd|phrase)|(?:^|[^a-z])pwd(?:[^a-z]|$)|(?:^|[^a-z])otp(?:[^a-z]|$)|one[\s_-]*time[\s_-]*code',
  caseSensitive: false,
);

/// Whether a field's visible or programmatic name says it holds a credential
/// or a payment instrument.
bool namesSensitiveField(String label) => paymentField.hasMatch(label) || credentialField.hasMatch(label);

/// What a text field says about itself, read from the widget on the device.
class FieldTraits {
  const FieldTraits({
    this.obscureText = false,
    this.autofillHints = const [],
    this.visiblePasswordKeyboard = false,
    this.names = const [],
  });

  /// `obscureText` on the `TextField`/`EditableText`.
  final bool obscureText;

  /// `autofillHints`, as given.
  final Iterable<String> autofillHints;

  /// `keyboardType: TextInputType.visiblePassword` — the "show password"
  /// variant of a login field, which `obscureText` stops covering the moment
  /// the eye is tapped.
  final bool visiblePasswordKeyboard;

  /// Hint, label, semantics label, the widget's string key, restoration id:
  /// whatever the field is called.
  final Iterable<String?> names;
}

/// Is this a field whose value never leaves the device, whatever the options?
bool isSensitiveField(FieldTraits field) {
  if (field.obscureText) return true;
  if (field.visiblePasswordKeyboard) return true;
  for (final hint in field.autofillHints) {
    if (sensitiveAutofillHints.contains(hint)) return true;
    // Web-shaped tokens an app may pass through (`cc-number`, `one-time-code`).
    if (_webSensitiveAutocomplete.contains(hint.toLowerCase())) return true;
  }
  for (final name in field.names) {
    if (name != null && name.isNotEmpty && namesSensitiveField(name)) return true;
  }
  return false;
}

const Set<String> _webSensitiveAutocomplete = {
  'password',
  'password-new',
  'new-password',
  'current-password',
  'sms-otp',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-day',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-middle-name',
  'cc-family-name',
  'cc-additional-name',
  'cc-type',
};

final RegExp _cardCharacters = RegExp(r'^[0-9][0-9 -]*[0-9]$');

/// Does this whole value look like a card number? 13–24 characters of
/// digits, spaces and dashes, 13–19 of them digits, Luhn-valid (contract §6.4).
bool looksLikeCardNumber(String value) {
  if (value.length < 13 || value.length > 24 || !_cardCharacters.hasMatch(value)) return false;
  final digits = value.replaceAll(RegExp(r'[ -]'), '');
  if (digits.length < 13 || digits.length > 19) return false;
  return luhnValid(digits);
}

/// The Luhn check over a string of digits.
bool luhnValid(String digits) {
  var sum = 0;
  var double = false;
  for (var i = digits.length - 1; i >= 0; i -= 1) {
    var digit = digits.codeUnitAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 == 0;
}

/// Could this value be a card number still being typed? Digits, spaces and
/// dashes only, starting 2–6, every group but the last at least four digits
/// long, and 7–19 digits in all (contract §6.4).
///
/// The screen is read on a tick, and a tick lands mid-number: a field with no
/// hints recorded `4242424…` in the clear until the value was long enough to
/// pass the Luhn check (found on an iOS simulator). The browser and React
/// Native SDKs' rule, byte for byte; `card-typing-vectors.json` holds the
/// cases all of them are tested against.
bool mayBecomeCardNumber(String value) {
  if (!_typingStart.hasMatch(value)) return false;
  final groups = value.split(_groupBreak);
  for (var i = 0; i < groups.length - 1; i += 1) {
    if (groups[i].length < 4) return false;
  }
  final digits = groups.join().length;
  return digits > 6 && digits <= 19;
}

final RegExp _typingStart = RegExp(r'^[2-6][0-9 -]*$');
final RegExp _groupBreak = RegExp(r'[ -]+');

/// A card number, whole or still being typed: what the floor masks in any
/// value a person typed.
bool cardShaped(String value) => looksLikeCardNumber(value) || mayBecomeCardNumber(value);

/// Digit groups joined by one space, no-break space or dash: where a card
/// number can hide in text.
final RegExp _digitRun = RegExp('[0-9]+(?:[  -][0-9]+)*');
final RegExp _runBreak = RegExp('[  -]');
final RegExp _anyDigit = RegExp('[0-9]');

/// Stars every card number inside longer text, and leaves the rest of it
/// (contract §6.4; the browser SDK's `maskCardRuns`, unchanged).
///
/// The rules above judge a whole value, so "my card is 4242 4242 4242 4242"
/// in a notes field went out in the clear. Each run of digit groups is
/// searched for the longest stretch of whole groups that is card shaped —
/// complete or still being typed — and only that stretch's digits are
/// starred; the words around it, and every other number, stay.
/// `card-run-vectors.json` holds the cases.
String maskCardRuns(String text) {
  if (!text.contains(_anyDigit)) return text;
  return text.replaceAllMapped(_digitRun, (match) {
    final run = match[0]!;
    final groups = run.split(_runBreak);
    // Where each group starts in the run, so a stretch of groups maps back to characters.
    final starts = <int>[];
    var at = 0;
    for (final group in groups) {
      starts.add(at);
      at += group.length + 1;
    }
    final chars = run.split('');
    var i = 0;
    while (i < groups.length) {
      var matched = -1;
      for (var j = groups.length - 1; j >= i; j -= 1) {
        final end = starts[j] + groups[j].length;
        if (cardShaped(run.substring(starts[i], end).replaceAll(' ', ' '))) {
          matched = j;
          break;
        }
      }
      if (matched < 0) {
        i += 1;
        continue;
      }
      final end = starts[matched] + groups[matched].length;
      for (var k = starts[i]; k < end; k += 1) {
        if (chars[k] != ' ' && chars[k] != ' ' && chars[k] != '-') chars[k] = '*';
      }
      i = matched + 1;
    }
    return chars.join();
  });
}
