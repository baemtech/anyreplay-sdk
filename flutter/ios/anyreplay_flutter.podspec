Pod::Spec.new do |s|
  s.name             = 'anyreplay_flutter'
  s.version          = '0.4.0'
  s.summary          = 'Session replay for Flutter apps: keeps crashes in native code for the next launch.'
  s.description      = <<-DESC
The native side of anyreplay_flutter. Keeps an uncaught Objective-C exception
or a fatal signal for the next launch, where the Dart side sends it.
                       DESC
  s.homepage         = 'https://anyreplay.com'
  s.license          = { :file => '../LICENSE' }
  s.author           = 'AnyReplay'
  s.source           = { :path => '.' }
  s.source_files     = 'anyreplay_flutter/Sources/**/*.{swift,h,m}'
  s.public_header_files = 'anyreplay_flutter/Sources/anyreplay_flutter_c/include/**/*.h'
  s.dependency 'Flutter'
  s.platform = :ios, '13.0'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'
end
