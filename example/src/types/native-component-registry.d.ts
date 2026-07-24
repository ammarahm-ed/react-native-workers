/**
 * React Native ships no types for this path, but it is the registration point
 * every codegen'd component uses. In bridgeless mode `get()` builds the view
 * config from the JS-side provider (`native: !global.RN$Bridgeless`), which is
 * what lets a runtime-registered view manager be rendered without any native
 * view config to look up.
 */
declare module 'react-native/Libraries/NativeComponent/NativeComponentRegistry' {
  import type { HostComponent } from 'react-native';

  export type PartialViewConfig = {
    uiViewClassName: string;
    bubblingEventTypes?: Record<string, any>;
    directEventTypes?: Record<string, any>;
    validAttributes?: Record<string, any>;
  };

  export function get<Config extends object>(
    name: string,
    viewConfigProvider: () => PartialViewConfig
  ): HostComponent<Config>;
}
