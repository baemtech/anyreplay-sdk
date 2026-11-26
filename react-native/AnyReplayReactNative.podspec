require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# The iOS half of @anyreplay/react-native: a small native module that writes
# down crashes in the app's own Objective-C and Swift code for the next launch
# (docs/SDK-CONTRACT.md §8.3). Linked by React Native's (and Expo's)
# autolinking. Optional: without it (Expo Go, an app not rebuilt) the
# JavaScript SDK records exactly as before.
Pod::Spec.new do |s|
  s.name = 'AnyReplayReactNative'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = package['homepage']
  s.author = 'Baem Tech'
  s.source = { :git => 'https://github.com/baemtech/anyreplay-sdk.git', :tag => "sdk-v#{package['version']}" }
  s.platforms = { :ios => '13.4' }
  s.source_files = 'ios/**/*.{h,m}'
  s.requires_arc = true

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end
end
