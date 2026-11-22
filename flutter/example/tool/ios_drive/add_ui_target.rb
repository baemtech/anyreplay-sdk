# Adds a UI-test target that drives the example with real taps and keystrokes
# on an iOS simulator, for a device test of anyreplay_flutter.
#
#   cd packages/recorder-flutter/example
#   flutter create --platforms=ios --org com.anyreplay .
#   mkdir -p ios/RunnerUITests && cp tool/ios_drive/DriveTests.swift ios/RunnerUITests/
#   GEM_HOME=$(brew --prefix cocoapods)/libexec ruby tool/ios_drive/add_ui_target.rb
#   flutter build ios --simulator --debug -t lib/device_test.dart \
#     --dart-define=ANYREPLAY_KEY=ar_pk_test_… --dart-define=ANYREPLAY_INGEST=http://localhost:4501
#   xcrun simctl install <udid> build/ios/iphonesimulator/Runner.app && xcrun simctl launch <udid> com.anyreplay.anyreplayFlutterExample
#   (cd ios && xcodebuild build-for-testing -project Runner.xcodeproj -scheme RunnerUITests \
#     -destination id=<udid> -derivedDataPath /tmp/ar-dd)
#   printf 'tap 118 341\nwait 2\ntype 298 4242424242424242\n' > /tmp/shots/steps.txt
#   (cd ios && TEST_RUNNER_SHOTS=/tmp/shots xcodebuild test-without-building -project Runner.xcodeproj \
#     -scheme RunnerUITests -destination id=<udid> -derivedDataPath /tmp/ar-dd \
#     -only-testing:RunnerUITests/DriveTests/testSteps)
#
# The example talks to http://localhost: give ios/Runner/Info.plist
# NSAppTransportSecurity > NSAllowsLocalNetworking = YES. The generated ios/
# folder is not committed; neither is this target.
require 'xcodeproj'

Dir.chdir(File.expand_path('../../ios', __dir__))
project = Xcodeproj::Project.open('Runner.xcodeproj')
exit 0 if project.targets.any? { |t| t.name == 'RunnerUITests' }

target = project.new_target(:ui_test_bundle, 'RunnerUITests', :ios, '15.0')
group = project.main_group.new_group('RunnerUITests', 'RunnerUITests')
target.add_file_references([group.new_file('DriveTests.swift')])
target.build_configurations.each do |config|
  config.build_settings['PRODUCT_NAME'] = 'RunnerUITests'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.anyreplay.RunnerUITests'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.save_as('Runner.xcodeproj', 'RunnerUITests', true)
