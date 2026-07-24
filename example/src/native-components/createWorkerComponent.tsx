/* eslint-disable @react-native/no-deep-imports -- NativeComponentRegistry is
   how every codegen'd component registers a static view config; the public
   `requireNativeComponent` takes the legacy path and asks native for the config,
   which a runtime-registered view manager cannot answer. */
import type { ComponentType } from 'react';
import type { HostComponent } from 'react-native';
import * as NativeComponentRegistry from 'react-native/Libraries/NativeComponent/NativeComponentRegistry';

/** A component descriptor the worker reports (see the worker's `list()`). */
export type Descriptor = { name: string; props: string[]; events: string[] };

/**
 * Host-side half of the worker-defined component library — a thin adapter over a
 * runtime-registered view manager. It builds a static view config so the component
 * mounts like any codegen'd one; props and events then flow through React Native's
 * OWN native pipelines, so this wrapper does nothing at runtime but forward them.
 *
 * - PROPS: the worker declared `propConfig_<name>` + a setter, so React sends each
 *   prop straight down RN's pipeline into the worker's `update()`.
 * - EVENTS: the worker captures RN's native dispatching block and fires it, so RN's
 *   own event system delivers `{ nativeEvent }` to the `on<Event>` prop. The
 *   `bubblingEventTypes` below is what registers those event names with RN.
 *
 * In bridgeless mode `NativeComponentRegistry.get` builds from this static config
 * (`native: !global.RN$Bridgeless`), which is why a runtime-registered view manager
 * works without a native view config to look up.
 */
const hostComponents = new Map<string, HostComponent<any>>();

function hostComponentFor(descriptor: Descriptor): HostComponent<any> {
  let component = hostComponents.get(descriptor.name);
  if (!component) {
    const validAttributes: Record<string, true> = {};
    for (const prop of descriptor.props) validAttributes[prop] = true;
    // Register each `on<Event>` so RN's event system routes the worker-dispatched
    // native event to the React callback prop.
    const bubblingEventTypes: Record<string, any> = {};
    for (const event of descriptor.events) {
      validAttributes[event] = true;
      const top = `top${event.slice(2)}`; // onValueChange → topValueChange
      bubblingEventTypes[top] = {
        phasedRegistrationNames: {
          bubbled: event,
          captured: `${event}Capture`,
        },
      };
    }
    component = NativeComponentRegistry.get(descriptor.name, () => ({
      uiViewClassName: descriptor.name,
      validAttributes,
      bubblingEventTypes,
    })) as HostComponent<any>;
    hostComponents.set(descriptor.name, component);
  }
  return component;
}

/** Build the React component for a worker-defined native component. Props and
 *  `on<Event>` callbacks pass straight through — RN drives both natively. */
export function createWorkerComponent(
  descriptor: Descriptor
): ComponentType<any> {
  const Host = hostComponentFor(descriptor);
  return function WorkerComponent(props: Record<string, any>) {
    return <Host {...props} />;
  };
}
