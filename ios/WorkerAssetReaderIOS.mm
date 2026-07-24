// iOS implementation of WorkerAssetReader: reads release worker bundles out of
// the app bundle.
//
// The release CLI emits `workers/<sanitized-id>.jsbundle` and the Xcode build
// phase (scripts/ios-bundle-workers.sh) copies that `workers/` directory into
// the app's resources. `[NSBundle mainBundle]` therefore sees them under a
// "workers" subdirectory.
//
// Bundles may be Hermes bytecode rather than JS — we read raw bytes and let
// Hermes detect the format on evaluate.

#import <Foundation/Foundation.h>

#include "../cpp/runtime/WorkerAssetReader.h"

namespace facebook::react::workers {
namespace {

class IosWorkerAssetReader : public WorkerAssetReader {
 public:
  bool read(const std::string& assetName, std::string& out, std::string& error)
      override {
    @autoreleasepool {
      NSString* name = [NSString stringWithUTF8String:assetName.c_str()];

      // assetName is "workers/foo.jsbundle": NSBundle wants the stem, the
      // extension and the subdirectory separately.
      NSString* subdir = [name stringByDeletingLastPathComponent];
      NSString* file = [name lastPathComponent];
      NSString* stem = [file stringByDeletingPathExtension];
      NSString* ext = [file pathExtension];

      NSURL* url = [[NSBundle mainBundle] URLForResource:stem
                                          withExtension:ext
                                           subdirectory:subdir.length ? subdir : nil];
      if (url == nil) {
        // Fall back to a flat lookup: some build configurations flatten
        // resource directories when copying.
        url = [[NSBundle mainBundle] URLForResource:stem withExtension:ext];
      }
      if (url == nil) {
        error = "not found in the app bundle";
        return false;
      }

      NSError* readError = nil;
      NSData* data = [NSData dataWithContentsOfURL:url
                                           options:NSDataReadingMappedIfSafe
                                             error:&readError];
      if (data == nil) {
        error = readError.localizedDescription
            ? std::string(readError.localizedDescription.UTF8String)
            : "unreadable";
        return false;
      }

      out.assign(static_cast<const char*>(data.bytes), data.length);
      return true;
    }
  }
};

} // namespace
} // namespace facebook::react::workers

@interface RNWorkersAssetReaderRegistration : NSObject
@end

@implementation RNWorkersAssetReaderRegistration

// Registered eagerly: reading from NSBundle needs nothing but the process, so
// unlike Android there is no reason to defer it.
+ (void)load {
  facebook::react::workers::setWorkerAssetReader(
      std::make_shared<facebook::react::workers::IosWorkerAssetReader>());
}

@end
