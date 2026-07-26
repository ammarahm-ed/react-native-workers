Pod::Spec.new do |s|
  s.name           = 'RNWProbe'
  s.version        = '1.0.0'
  s.summary        = 'Local Expo module used to exercise Expo properties + events inside a worker'
  s.description    = 'Test-only module: a Constant, a static Property, a dynamic Property, and an Event fired on demand.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
