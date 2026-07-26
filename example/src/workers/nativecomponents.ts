// A native component library written entirely in JavaScript, running inside a
// UIWorker. No native code, no codegen, no podspec.
//
// Each class below becomes a real React Native host component: the helper
// registers an Obj-C view manager for it at runtime, so Fabric mounts it and
// Yoga lays it out exactly like `RCTView`. See `helpers/native-component.ts`
// for how that registration works.
//
// Because this runs in a UIWorker, `create()` and `update()` are already on the
// main thread — UIKit calls here are direct and synchronous.
import NativeScript from '@nativescript/react-native';
import {
  NativeComponent,
  registerComponents,
  serveComponents,
} from './helpers/native-component';

NativeScript.init();

// MapKit and CoreLocation are not linked into the app, and `objc_lookUpClass`
// does not trigger a load — so bring the images in before touching `MKMapView`
// or the `CLLocationCoordinate2DMake` struct maker.
NativeScript.loadFramework('MapKit');
NativeScript.loadFramework('CoreLocation');

/** A rounded, coloured badge with a label. */
class WorkerBadge extends NativeComponent {
  static props = ['title', 'tone'];
  private label: any;

  create() {
    const view = UIView.alloc().initWithFrame(CGRectMake(0, 0, 120, 44));
    view.layer.cornerRadius = 10;
    view.clipsToBounds = true;

    this.label = UILabel.alloc().initWithFrame(view.bounds);
    this.label.autoresizingMask =
      UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
    this.label.textAlignment = NSTextAlignment.Center;
    this.label.textColor = UIColor.whiteColor;
    this.label.font = UIFont.boldSystemFontOfSize(15);
    view.addSubview(this.label);

    return view;
  }

  update(props: { title?: string; tone?: 'blue' | 'green' | 'pink' }) {
    this.label.text = String(props.title ?? 'badge');
    this.view.backgroundColor =
      props.tone === 'green'
        ? UIColor.systemGreenColor
        : props.tone === 'pink'
          ? UIColor.systemPinkColor
          : UIColor.systemBlueColor;
  }
}

/** A real UISwitch: `value` flows down as a native prop, its change event comes
 *  back up through RN's native event pipeline. */
class WorkerSwitch extends NativeComponent {
  static props = ['value', 'tint'];
  static events = ['onValueChange'];

  create() {
    // `hostView` gives us a UISwitch subclass that captures RN's native event
    // blocks, so `emit` can deliver `onValueChange` through RN's own pipeline.
    const view = this.hostView(UISwitch)
      .alloc()
      .initWithFrame(CGRectMake(0, 0, 51, 31));
    this.onControl(view, UIControlEvents.ValueChanged, () =>
      this.emit('onValueChange', { value: view.on })
    );
    return view;
  }

  update(props: { value?: boolean; tint?: boolean }) {
    if (props.value != null && this.view.on !== !!props.value) {
      this.view.setOnAnimated(!!props.value, true);
    }
    if (props.tint) {
      this.view.onTintColor = UIColor.systemGreenColor;
    }
  }
}

/**
 * A live MapKit map — the deep-end demo.
 *
 * In Objective-C this is a chore: you allocate the map, build a delegate class
 * conforming to `MKMapViewDelegate`, implement `mapView:viewForAnnotation:` to
 * recycle `MKMarkerAnnotationView`s, implement `mapView:didSelectAnnotationView:`
 * and `mapView:regionDidChangeAnimated:`, and drive the camera with C struct
 * makers (`CLLocationCoordinate2DMake`, `MKCoordinateRegionMakeWithDistance`).
 * Every one of those is a real Obj-C construct — struct args, a protocol-
 * conforming delegate, annotation recycling. Here it is a couple of dozen lines
 * of JavaScript, in a worker, with no native module.
 */
type MapPin = { id?: string; lat: number; lng: number; title?: string };

class WorkerMap extends NativeComponent {
  static props = ['lat', 'lng', 'radius', 'mapType', 'pins'];
  static events = ['onSelectPin', 'onRegionChange'];
  private annotations = new Map<string, any>(); // pin id -> MKPointAnnotation

  create() {
    const map = this.hostView(MKMapView)
      .alloc()
      .initWithFrame(CGRectMake(0, 0, 320, 320));
    map.showsUserLocation = false;

    // A real MKMapViewDelegate, its methods written in JS as arrow functions so
    // `this` stays the component. The interop reads each selector's signature
    // from the metadata and marshals the arguments — including the
    // `MKCoordinateRegion` struct handed to us below.
    map.delegate = this.delegate<any>('MKMapViewDelegate', {
      // Customise each pin. Returning a configured MKMarkerAnnotationView is the
      // canonical "you must know MapKit" method.
      mapViewViewForAnnotation: (mapView: any, annotation: any) => {
        const id = 'workerPin';
        let view = mapView.dequeueReusableAnnotationViewWithIdentifier(id);
        if (!view) {
          view =
            MKMarkerAnnotationView.alloc().initWithAnnotationReuseIdentifier(
              annotation,
              id
            );
          view.canShowCallout = true;
        } else {
          view.annotation = annotation;
        }
        view.markerTintColor = UIColor.systemIndigoColor;
        view.glyphImage = UIImage.systemImageNamed('star.fill');
        return view;
      },

      mapViewDidSelectAnnotationView: (_mapView: any, view: any) => {
        const c = view.annotation.coordinate;
        this.emit('onSelectPin', {
          lat: c.latitude,
          lng: c.longitude,
          title: String(view.annotation.title ?? ''),
        });
      },

      // The region struct arrives fully marshalled — read its center/span
      // straight off the JS object.
      mapViewRegionDidChangeAnimated: (mapView: any) => {
        const r = mapView.region;
        this.emit('onRegionChange', {
          lat: r.center.latitude,
          lng: r.center.longitude,
          latitudeDelta: r.span.latitudeDelta,
          longitudeDelta: r.span.longitudeDelta,
        });
      },
    });

    return map;
  }

  update(props: {
    lat?: number;
    lng?: number;
    radius?: number;
    mapType?: 'standard' | 'satellite' | 'hybrid';
    pins?: MapPin[];
  }) {
    const map = this.view;

    if (typeof props.lat === 'number' && typeof props.lng === 'number') {
      const center = CLLocationCoordinate2DMake(props.lat, props.lng);
      const meters = (props.radius ?? 1) * 1000;
      // MKCoordinateRegionMakeWithDistance turns a center + metre span into the
      // lat/long-degree region MapKit actually wants — pure MapKit trig you get
      // for free.
      const region = MKCoordinateRegionMakeWithDistance(center, meters, meters);
      map.setRegionAnimated(region, true);
    }

    if (props.mapType) {
      map.mapType =
        props.mapType === 'satellite'
          ? MKMapType.Satellite
          : props.mapType === 'hybrid'
            ? MKMapType.Hybrid
            : MKMapType.Standard;
    }

    if (Array.isArray(props.pins)) {
      const next = new Map<string, MapPin>();
      props.pins.forEach((pin, i) => next.set(pin.id ?? `pin-${i}`, pin));

      // Remove annotations that are gone.
      for (const [id, annotation] of this.annotations) {
        if (!next.has(id)) {
          map.removeAnnotation(annotation);
          this.annotations.delete(id);
        }
      }
      // Add annotations that are new. MKPointAnnotation already conforms to
      // MKAnnotation, so no custom annotation class is needed here.
      for (const [id, pin] of next) {
        if (this.annotations.has(id)) continue;
        const annotation = MKPointAnnotation.alloc().init();
        annotation.coordinate = CLLocationCoordinate2DMake(pin.lat, pin.lng);
        annotation.title = pin.title ?? '';
        map.addAnnotation(annotation);
        this.annotations.set(id, annotation);
      }
    }
  }
}

/**
 * A container component: real UIKit chrome around ordinary React children.
 *
 * `UIVisualEffectView` is the classic "you need a native module for this" view —
 * a live backdrop blur RN cannot express in JS. Here it is the host view of a
 * worker-defined component, and everything you nest inside it in JSX is still
 * plain React: `<Text>`, `<Image>`, `<Pressable>`, even another worker-defined
 * component.
 *
 * The children arrive through React Native's own mounting path — Fabric's
 * legacy-interop layer calls `insertReactSubview:atIndex:` then
 * `didUpdateReactSubviews` on this view, and Yoga has already laid each child out
 * against this view's box. The only thing this component does is say WHERE they
 * land: `UIVisualEffectView` requires its subviews to go into `contentView`, so
 * `childrenView()` returns that instead of the view itself.
 */
class WorkerCard extends NativeComponent {
  static props = ['material', 'cornerRadius'];
  static events = ['onChildrenChange'];

  create() {
    const view = this.hostView(UIVisualEffectView)
      .alloc()
      .initWithEffect(UIBlurEffect.effectWithStyle(UIBlurEffectStyle.Regular));
    view.clipsToBounds = true;
    view.layer.cornerRadius = 16;
    view.layer.borderWidth = 1;
    view.layer.borderColor = UIColor.colorWithWhiteAlpha(1, 0.35).CGColor;
    return view;
  }

  /** React children are subviews of the blur's `contentView`, not of the effect
   *  view — the placement UIKit demands, invisible to the JSX above. */
  childrenView() {
    return this.view.contentView;
  }

  /** React mounted or unmounted children. On the first mount this runs before RN
   *  has set the event props, so hop a tick — by then the `onChildrenChange`
   *  block is captured and the very first count is delivered too. */
  childrenChanged(count: number) {
    setTimeout(() => this.emit('onChildrenChange', { count }), 0);
  }

  update(props: {
    material?: 'regular' | 'thin' | 'chrome' | 'dark';
    cornerRadius?: number;
  }) {
    if (props.material) {
      this.view.effect = UIBlurEffect.effectWithStyle(
        props.material === 'thin'
          ? UIBlurEffectStyle.SystemThinMaterial
          : props.material === 'chrome'
            ? UIBlurEffectStyle.SystemChromeMaterial
            : props.material === 'dark'
              ? UIBlurEffectStyle.SystemMaterialDark
              : UIBlurEffectStyle.Regular
      );
    }
    if (typeof props.cornerRadius === 'number') {
      this.view.layer.cornerRadius = props.cornerRadius;
    }
  }
}

registerComponents([WorkerBadge, WorkerSwitch, WorkerMap, WorkerCard]);
serveComponents();
