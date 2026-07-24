/* eslint-disable @react-native/no-deep-imports -- NativeComponentRegistry is
   how every codegen'd component registers a static view config; the public
   `requireNativeComponent` takes the legacy path and asks native for the config,
   which a runtime-registered view manager cannot answer. */
import { useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { findNodeHandle } from 'react-native';
import type { HostComponent } from 'react-native';
import * as NativeComponentRegistry from 'react-native/Libraries/NativeComponent/NativeComponentRegistry';
import type { UIWorker } from '@ammarahmed/react-native-workers';

/** A component descriptor the worker reports (see the worker's `list()`). */
export type Descriptor = { name: string; props: string[]; events: string[] };

/**
 * Host-side half of the worker-defined component library.
 *
 * PROPS are native: the worker registered `propConfig_<name>` class methods +
 * setters, so React sends them straight down RN's own pipeline — this wrapper
 * just forwards them. EVENTS come back over the worker's RPC channel (NativeScript
 * can't invoke RN's native event block), routed to the right mounted instance by
 * its React tag and delivered as `{ nativeEvent }`, matching RN's event shape.
 *
 * In bridgeless mode `NativeComponentRegistry.get` builds from this static config
 * (`native: !global.RN$Bridgeless`), which is why a runtime-registered view
 * manager works without a native view config to look up.
 */
const hostComponents = new Map<string, HostComponent<any>>();
const eventTargets = new Map<number, (event: string, payload: any) => void>();

function hostComponentFor(descriptor: Descriptor): HostComponent<any> {
  let component = hostComponents.get(descriptor.name);
  if (!component) {
    const validAttributes: Record<string, true> = {};
    for (const prop of descriptor.props) validAttributes[prop] = true;
    component = NativeComponentRegistry.get(descriptor.name, () => ({
      uiViewClassName: descriptor.name,
      validAttributes,
    })) as HostComponent<any>;
    hostComponents.set(descriptor.name, component);
  }
  return component;
}

/** Wire the worker's event channel to the mounted instances (call once per worker). */
export function installComponentEventBridge(worker: UIWorker): void {
  (worker as any).registerModule('host', {
    dispatchEvent(message: {
      tag: number | null;
      event: string;
      payload: any;
    }) {
      if (message.tag != null) {
        eventTargets.get(message.tag)?.(message.event, message.payload);
      }
    },
  });
}

/** Build the React component for a worker-defined native component. */
export function createWorkerComponent(
  descriptor: Descriptor
): ComponentType<any> {
  const Host = hostComponentFor(descriptor);

  return function WorkerComponent(props: Record<string, any>) {
    const { style, ...rest } = props;
    const ref = useRef<any>(null);

    // Event callbacks are held here and dispatched by tag; native props (the
    // rest) pass straight through to the host component.
    const callbacks = useRef<Record<string, any>>({});
    const native: Record<string, any> = {};
    callbacks.current = {};
    for (const [key, value] of Object.entries(rest)) {
      if (typeof value === 'function' && key.startsWith('on')) {
        callbacks.current[key] = value;
      } else {
        native[key] = value;
      }
    }

    useEffect(() => {
      const tag = findNodeHandle(ref.current);
      if (tag == null) return;
      eventTargets.set(tag, (event, payload) =>
        callbacks.current[event]?.({ nativeEvent: payload })
      );
      return () => {
        eventTargets.delete(tag);
      };
    }, []);

    return <Host ref={ref} style={style} {...native} />;
  };
}
