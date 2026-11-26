import 'dart:io';

import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('sdkVersion is the version in pubspec.yaml', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final version = RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec)!.group(1);
    expect(sdkVersion, version);
    expect(sdkName, 'anyreplay_flutter');
  });

  test('the changelog describes this version', () {
    expect(File('CHANGELOG.md').readAsStringSync(), contains('## $sdkVersion'));
  });

  test('the version is semantic, short enough for meta.sdk.version', () {
    expect(RegExp(r'^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$').hasMatch(sdkVersion), isTrue);
    expect(sdkVersion.length, lessThanOrEqualTo(24));
  });
}
