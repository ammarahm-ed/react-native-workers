require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "UIWorkerDemo"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = "MIT"
  s.authors      = "react-native-workers example"
  s.homepage     = "https://github.com/ammarahm-ed/react-native-workers"
  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }

  s.source_files = "cpp/**/*.{h,cpp}", "ios/**/*.{h,mm}"
  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\"",
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20"
  }

  install_modules_dependencies(s)
end
