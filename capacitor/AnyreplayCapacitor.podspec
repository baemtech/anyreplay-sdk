require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# For apps that link plugins with CocoaPods (Capacitor 7 and older projects).
# Capacitor 8 links with Swift Package Manager through Package.swift.
Pod::Spec.new do |s|
  s.name = 'AnyreplayCapacitor'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = package['homepage']
  s.author = 'Baem Tech'
  s.source = { :git => 'https://github.com/baemtech/anyreplay-sdk.git', :tag => "sdk-v#{package['version']}" }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
