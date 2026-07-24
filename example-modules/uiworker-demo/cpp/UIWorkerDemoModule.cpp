#include "UIWorkerDemoModule.h"

#include <ReactCommon/CxxTurboModuleUtils.h>

#include <mutex>

namespace uiworkerdemo {

using namespace facebook;
using namespace facebook::react;

namespace {

Platform*& platformRef() {
  static Platform* p = nullptr;
  return p;
}

// Every UI-affine method funnels through here. Touching UIKit off the main
// thread is undefined behaviour that usually "works" in testing and crashes in
// the field, so refuse loudly instead: from a background Worker this throws, and
// the message says exactly what to use instead.
Platform& requireMainThread(jsi::Runtime& rt, const char* method) {
  Platform* p = platformRef();
  if (!p) {
    throw jsi::JSError(rt, "UIWorkerDemo has no platform implementation on this OS.");
  }
  if (!p->isOnMainThread()) {
    throw jsi::JSError(
        rt,
        std::string("UIWorkerDemo.") + method +
            "() must run on the main thread. Create the worker with `new UIWorker(...)` "
            "— a background Worker cannot touch UI directly.");
  }
  return *p;
}

jsi::Value isOnMainThread(jsi::Runtime& rt, TurboModule&, const jsi::Value*, size_t) {
  Platform* p = platformRef();
  return jsi::Value(p != nullptr && p->isOnMainThread());
}

jsi::Value threadName(jsi::Runtime& rt, TurboModule&, const jsi::Value*, size_t) {
  Platform* p = platformRef();
  std::string name = p ? p->threadName() : "<no platform>";
  return jsi::Value(jsi::String::createFromUtf8(rt, name));
}

jsi::Value showAlert(
    jsi::Runtime& rt,
    TurboModule&,
    const jsi::Value* args,
    size_t count) {
  Platform& p = requireMainThread(rt, "showAlert");
  std::string title = count > 0 && args[0].isString() ? args[0].getString(rt).utf8(rt) : "";
  std::string message = count > 1 && args[1].isString() ? args[1].getString(rt).utf8(rt) : "";
  // Direct presentation — no dispatch_async. Legal only because we verified the
  // caller is already on the main thread.
  p.showAlert(title, message);
  return jsi::Value::undefined();
}

jsi::Value setStatusBarHidden(
    jsi::Runtime& rt,
    TurboModule&,
    const jsi::Value* args,
    size_t count) {
  Platform& p = requireMainThread(rt, "setStatusBarHidden");
  p.setStatusBarHidden(count > 0 && args[0].isBool() && args[0].getBool());
  return jsi::Value::undefined();
}

jsi::Value getBrightness(jsi::Runtime& rt, TurboModule&, const jsi::Value*, size_t) {
  Platform& p = requireMainThread(rt, "getBrightness");
  return jsi::Value(p.getBrightness());
}

jsi::Value setBrightness(
    jsi::Runtime& rt,
    TurboModule&,
    const jsi::Value* args,
    size_t count) {
  Platform& p = requireMainThread(rt, "setBrightness");
  if (count < 1 || !args[0].isNumber()) {
    throw jsi::JSError(rt, "setBrightness(value) requires a number between 0 and 1");
  }
  p.setBrightness(args[0].getNumber());
  return jsi::Value::undefined();
}

jsi::Value viewExists(
    jsi::Runtime& rt,
    TurboModule&,
    const jsi::Value* args,
    size_t count) {
  Platform& p = requireMainThread(rt, "viewExists");
  if (count < 1 || !args[0].isNumber()) return jsi::Value(false);
  return jsi::Value(p.viewExists(static_cast<int32_t>(args[0].getNumber())));
}

jsi::Value setViewTransform(
    jsi::Runtime& rt,
    TurboModule&,
    const jsi::Value* args,
    size_t count) {
  Platform& p = requireMainThread(rt, "setViewTransform");
  if (count < 2 || !args[0].isNumber() || !args[1].isObject()) {
    throw jsi::JSError(rt, "setViewTransform(tag, props) requires (number, object)");
  }
  jsi::Object o = args[1].getObject(rt);
  auto num = [&](const char* key, double fallback) {
    jsi::Value v = o.getProperty(rt, key);
    return v.isNumber() ? v.getNumber() : fallback;
  };
  double scale = num("scale", 1);
  p.setViewTransform(
      static_cast<int32_t>(args[0].getNumber()),
      num("translateX", 0),
      num("translateY", 0),
      num("scaleX", scale),
      num("scaleY", scale),
      num("rotate", 0));
  return jsi::Value::undefined();
}

jsi::Value setViewOpacity(
    jsi::Runtime& rt,
    TurboModule&,
    const jsi::Value* args,
    size_t count) {
  Platform& p = requireMainThread(rt, "setViewOpacity");
  if (count < 2 || !args[0].isNumber() || !args[1].isNumber()) {
    throw jsi::JSError(rt, "setViewOpacity(tag, value) requires (number, number)");
  }
  p.setViewOpacity(
      static_cast<int32_t>(args[0].getNumber()), args[1].getNumber());
  return jsi::Value::undefined();
}

jsi::Value vibrate(jsi::Runtime& rt, TurboModule&, const jsi::Value*, size_t) {
  Platform& p = requireMainThread(rt, "vibrate");
  p.vibrate();
  return jsi::Value::undefined();
}

} // namespace

void setPlatform(Platform* platform) {
  platformRef() = platform;
}

Platform* getPlatform() {
  return platformRef();
}

UIWorkerDemoModule::UIWorkerDemoModule(std::shared_ptr<CallInvoker> jsInvoker)
    : TurboModule(kModuleName, std::move(jsInvoker)) {
  methodMap_["isOnMainThread"] = MethodMetadata{0, uiworkerdemo::isOnMainThread};
  methodMap_["threadName"] = MethodMetadata{0, uiworkerdemo::threadName};
  methodMap_["showAlert"] = MethodMetadata{2, uiworkerdemo::showAlert};
  methodMap_["setStatusBarHidden"] = MethodMetadata{1, uiworkerdemo::setStatusBarHidden};
  methodMap_["getBrightness"] = MethodMetadata{0, uiworkerdemo::getBrightness};
  methodMap_["setBrightness"] = MethodMetadata{1, uiworkerdemo::setBrightness};
  methodMap_["vibrate"] = MethodMetadata{0, uiworkerdemo::vibrate};
  methodMap_["viewExists"] = MethodMetadata{1, uiworkerdemo::viewExists};
  methodMap_["setViewTransform"] = MethodMetadata{2, uiworkerdemo::setViewTransform};
  methodMap_["setViewOpacity"] = MethodMetadata{2, uiworkerdemo::setViewOpacity};
}

void UIWorkerDemoModule::registerSelf() {
  static std::once_flag once;
  std::call_once(once, [] {
    registerCxxModuleToGlobalModuleMap(
        std::string(kModuleName),
        [](std::shared_ptr<CallInvoker> jsInvoker) {
          return std::make_shared<UIWorkerDemoModule>(std::move(jsInvoker));
        });
  });
}

} // namespace uiworkerdemo
