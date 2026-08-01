// A real UICollectionView — data source, delegate, cell recycling and all —
// written in JavaScript inside a UIWorker, with React's own views as the cells.
//
// The split is the whole point:
//
//   • REACT owns what a row LOOKS like. `WorkerFeed`'s React children are a
//     pool of identical cell templates written in JSX. Yoga lays each one out
//     once, at mount. They are ordinary React views.
//   • THE WORKER owns what a row SAYS. The changing parts of the template are
//     `WorkerText` / `WorkerArt` — worker-defined host components, so the
//     UILabel and the UIImageView behind them belong to this runtime and can be
//     assigned to directly.
//   • So recycling is: park a template in the dequeued cell, then write the new
//     row's strings into its labels. No React render, no state, no diff — and
//     none of it needs the JS thread to be free.
//
// Everything below runs on the platform main thread, because a UIWorker's JS
// lives there. Every UIKit call is a direct message send.
import NativeScript from '@nativescript/react-native';
import {
  NativeComponent,
  registerComponents,
  serveComponents,
} from './helpers/native-component';
import {
  ART_COUNT,
  buildFeed,
  compact,
  FEED_COUNT,
  LIVE_BUFFER,
  LIVE_BYTES,
  LIVE_STRIDE,
} from './helpers/feed';

declare const SharedBuffer: any;
declare const SharedValue: any;

NativeScript.init();

const g = globalThis as any;

/** The static rows — built here, identical to the ones the host built. */
const items = buildFeed(FEED_COUNT);
/** The live rows — the producer worker's bytes, read straight from memory. */
const live = new Int32Array(
  new SharedBuffer(LIVE_BUFFER, LIVE_BYTES).arrayBuffer
);

/** Stats the screen polls. Shared cells, so publishing them can't block on the
 *  JS thread and reading them can't block on this one. */
const uiRate = new SharedValue('feed.rate', 0);
const uiPatched = new SharedValue('feed.patched', 0);

/* ─────────────────────────────────────────────────────── thumbnails ── */

/** The thumbnails, drawn once — the same two-colour gradients the React side
 *  loads as PNGs, so both columns show the same picture. */
const art: any[] = [];
function buildArt() {
  if (art.length) return;
  const size = 96;
  const renderer = UIGraphicsImageRenderer.alloc().initWithSize(
    CGSizeMake(size, size)
  );
  for (let i = 0; i < ART_COUNT; i++) {
    const hue = i / ART_COUNT;
    const layer = CAGradientLayer.layer();
    layer.frame = CGRectMake(0, 0, size, size);
    layer.colors = NSArray.arrayWithArray([
      UIColor.colorWithHueSaturationBrightnessAlpha(hue, 0.45, 0.92, 1).CGColor,
      UIColor.colorWithHueSaturationBrightnessAlpha(
        (hue + 0.12) % 1,
        0.72,
        0.62,
        1
      ).CGColor,
    ]);
    layer.startPoint = CGPointMake(0, 0);
    layer.endPoint = CGPointMake(1, 1);
    art.push(
      renderer.imageWithActions((ctx: any) =>
        layer.renderInContext(ctx.CGContext)
      )
    );
  }
}

function color(hex: string): any {
  // Props arrive from Obj-C, so coerce before touching String methods.
  const n = parseInt(String(hex).replace('#', ''), 16);
  return UIColor.colorWithRedGreenBlueAlpha(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    1
  );
}

/* ────────────────────────────────────────────────── the cell template ── */

/** slot index → the leaf views React mounted for it. */
type Slot = { root: any; row: number } & Record<string, any>;
const slots = new Map<number, Slot>();

function slotFor(index: number): Slot {
  let slot = slots.get(index);
  if (!slot) slots.set(index, (slot = { root: null, row: -1 } as Slot));
  return slot;
}

/** Called by the list once every template has reported its views. */
let onSlotsReady: (() => void) | null = null;

/**
 * A template's root view is simply the parent of the views inside it. React
 * mounted it; the leaf tells us where it landed.
 *
 * This is deliberately NOT read out of RN's own `reactSubviews` list: that
 * comes back through the interop as an `NSArray` whose marshalling is not
 * dependable here — sometimes boxed inside a JS array, sometimes with elements
 * that are no longer usable views. One `superview` read per leaf is exact.
 */
function noticeSlot(): void {
  onSlotsReady?.();
}

/**
 * A template's root view, found from the leaves inside it.
 *
 * RN's legacy-interop layer wraps every worker-defined component in a view of
 * its own, so a leaf's `superview` is that wrapper, not the template. The
 * template is the lowest ancestor two different leaves have in common — which
 * holds however many wrappers RN decides to put in between.
 */
function rootOf(index: number): any {
  const slot = slotFor(index);
  if (slot.root) return slot.root;
  const a = slot.author;
  const b = slot.art;
  if (!a || !b) return null;
  const seen = new Set<any>();
  for (let v = a.superview; v; v = v.superview) seen.add(v);
  for (let v = b.superview; v; v = v.superview) {
    if (seen.has(v)) {
      slot.root = v;
      return v;
    }
  }
  return null;
}

/** A UILabel inside a cell template, owned by this runtime. */
class WorkerText extends NativeComponent {
  static props = ['slot', 'field', 'size', 'weight', 'hex', 'align', 'lines'];

  create() {
    const label = UILabel.alloc().initWithFrame(CGRectMake(0, 0, 80, 16));
    label.numberOfLines = 1;
    return label;
  }

  update(props: any) {
    const label = this.view;
    if (props.lines != null) label.numberOfLines = props.lines;
    if (props.size) {
      label.font =
        props.weight === 'bold'
          ? UIFont.boldSystemFontOfSize(props.size)
          : UIFont.systemFontOfSize(props.size);
    }
    if (props.hex) {
      label.textColor = color(props.hex);
    }
    if (props.align === 'right') label.textAlignment = NSTextAlignment.Right;
    // Publishing the view under (slot, field) is the entire binding step: from
    // here on the list writes `label.text` and React is not involved again.
    if (props.slot != null && props.field) {
      (slotFor(props.slot) as any)[props.field] = label;
    }
  }
}

/** A UIImageView inside a cell template. */
class WorkerArt extends NativeComponent {
  static props = ['slot', 'field', 'radius'];

  create() {
    const view = UIImageView.alloc().initWithFrame(CGRectMake(0, 0, 44, 44));
    view.contentMode = UIViewContentMode.ScaleAspectFill;
    view.clipsToBounds = true;
    view.backgroundColor = color('#e6e9ee');
    return view;
  }

  update(props: any) {
    if (props.radius != null) this.view.layer.cornerRadius = props.radius;
    if (props.slot != null && props.field) {
      (slotFor(props.slot) as any)[props.field] = this.view;
      noticeSlot();
    }
  }
}

/** A dot the worker slides back and forth on its own loop — the same animation
 *  the React column runs on the JS thread, so the two headers show, side by
 *  side, what each thread is managing to do per frame. */
const pulses: any[] = [];

class WorkerPulse extends NativeComponent {
  static props = ['hex', 'travel'];
  private travel = 100;

  create() {
    const view = UIView.alloc().initWithFrame(CGRectMake(0, 0, 10, 10));
    view.layer.cornerRadius = 5;
    pulses.push(this);
    return view;
  }

  update(props: any) {
    if (props.hex) this.view.backgroundColor = color(props.hex);
    if (props.travel != null) this.travel = props.travel;
  }

  /** Called from the list's loop. */
  advance(t: number): void {
    const x = (1 - Math.cos(t * 2.2)) * 0.5 * this.travel;
    this.view.transform = CGAffineTransformMakeTranslation(x, 0);
  }

  dispose() {
    const i = pulses.indexOf(this);
    if (i >= 0) pulses.splice(i, 1);
  }
}

/* ──────────────────────────────────────────────────────── the list ── */

let CellClass: any;
function cellClass() {
  if (!CellClass) {
    CellClass = g.UICollectionViewCell.extend(
      {},
      { name: 'RNWFeedCell', exposedMethods: {} }
    );
  }
  return CellClass;
}

/**
 * Drive `cb` on the main thread, as often as the main thread will have us.
 *
 * A UIWorker's timers ARE main-thread timers, so this is a main-thread loop
 * with no dispatch in it — and its rate is a direct read on how healthy that
 * thread is. (A CADisplayLink whose target-action is a JS method never fires
 * for a worker runtime; a timer is what works today.)
 */
function onEveryFrame(cb: () => void): { stop: () => void } {
  const timer = setInterval(cb, 8);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** The React list's own UIScrollView, so this loop can scroll BOTH columns at
 *  exactly the same speed on the same thread. Otherwise the FlatList would be
 *  scrolled from JS, and a stalled JS thread would slow its scroll instead of
 *  only its rendering — a different comparison than the one being made. */
let peerScroll: any = null;

/** Depth-first search for the first UIScrollView inside `view`. */
function findScrollView(view: any): any {
  if (!view) return null;
  if (view.isKindOfClass(UIScrollView)) return view;
  const subviews = view.subviews;
  for (let i = 0; i < (subviews ? subviews.count : 0); i++) {
    const found = findScrollView(subviews.objectAtIndex(i));
    if (found) return found;
  }
  return null;
}

class WorkerFeed extends NativeComponent {
  static props = ['itemWidth', 'shapes', 'heights', 'speed', 'running'];

  private layout: any;
  /** Where React's cell templates wait when no cell is showing them. */
  private pool: any;
  /** Templates in React child order — index === the `slot` prop. */
  private roots: any[] = [];
  private cellOfSlot = new Map<number, number>(); // slot → cell tag
  private slotOfCell = new Map<number, number>(); // cell tag → slot
  /** Body lines of each template, in React child order. */
  private shapes: number[] = [];
  /** Row height per shape, indexed by lines - 1. */
  private heights: number[] = [];
  private itemWidth = 180;
  /** Free templates per shape. A row can only borrow a template of its own
   *  height, so the pool is really one pool per shape. */
  private free = new Map<number, number[]>();
  /** Cell tags in the order their slot was claimed — the oldest is the one to
   *  steal from when every template is spoken for. */
  private claimed: number[] = [];
  private cellSeq = 0;
  private frame: { stop: () => void } | null = null;
  private speed = 34; // points per second
  private running = true;
  private painted = 0;
  private frames = 0;
  private since = Date.now();
  private since0 = Date.now();

  create() {
    buildArt();

    this.layout = UICollectionViewFlowLayout.alloc().init();
    this.layout.scrollDirection = UICollectionViewScrollDirection.Vertical;
    this.layout.minimumLineSpacing = 0;
    this.layout.minimumInteritemSpacing = 0;

    const view = this.hostView(UICollectionView)
      .alloc()
      .initWithFrameCollectionViewLayout(
        CGRectMake(0, 0, 180, 400),
        this.layout
      );
    view.backgroundColor = UIColor.clearColor;
    view.showsVerticalScrollIndicator = false;
    view.registerClassForCellWithReuseIdentifier(cellClass(), 'cell');

    // The pool is an ordinary UIView parked off-screen inside the list; React
    // mounts its children there and the list moves them into cells.
    this.pool = UIView.alloc().initWithFrame(CGRectMake(0, 0, 0, 0));
    this.pool.clipsToBounds = true;
    view.addSubview(this.pool);
    onSlotsReady = () => this.adopt();

    view.dataSource = this.delegate<any>('UICollectionViewDataSource', {
      collectionViewNumberOfItemsInSection: () => FEED_COUNT,
      numberOfSectionsInCollectionView: () => 1,
      collectionViewCellForItemAtIndexPath: (cv: any, indexPath: any) =>
        this.cellFor(cv, indexPath),
    });

    view.delegate = this.delegate<any>(
      ['UICollectionViewDelegate', 'UICollectionViewDelegateFlowLayout'],
      {
        // Rows are not all the same height, so the layout has to ask. The
        // answer comes out of the row's own text, on this thread.
        collectionViewLayoutSizeForItemAtIndexPath: (
          _cv: any,
          _layout: any,
          indexPath: any
        ) => {
          return CGSizeMake(this.itemWidth, this.heightOf(indexPath.item));
        },
        collectionViewDidEndDisplayingCellForItemAtIndexPath: (
          _cv: any,
          cell: any
        ) => this.release(cell),
      }
    );

    return view;
  }

  /** Adopt the templates once React has mounted every one of them. */
  private adopt(): void {
    if (!this.shapes.length) return;
    const roots: any[] = [];
    for (let i = 0; i < this.shapes.length; i++) {
      const root = rootOf(i);
      if (!root) return; // not all of them are mounted yet
      roots.push(root);
    }
    if (this.roots.length === roots.length) return;
    this.roots = roots;
    this.rebuildPools();
  }

  /** Sort the templates into one free pool per row height. Runs whenever the
   *  children or the shape table change — they arrive as separate updates. */
  private rebuildPools(): void {
    if (!this.roots.length || this.shapes.length !== this.roots.length) return;
    this.free = new Map();
    this.roots.forEach((_, i) => {
      const lines = this.shapes[i] ?? 1;
      const pool = this.free.get(lines) ?? [];
      pool.push(i);
      this.free.set(lines, pool);
    });
    this.cellOfSlot.clear();
    this.slotOfCell.clear();
    this.claimed = [];
    this.view.reloadData();
  }

  update(props: any) {
    if (props.itemWidth) this.itemWidth = props.itemWidth;
    if (props.shapes !== undefined) {
    }
    if (
      Array.isArray(props.shapes) &&
      props.shapes.length !== this.shapes.length
    ) {
      this.shapes = props.shapes;
      this.rebuildPools();
    }
    if (Array.isArray(props.heights)) this.heights = props.heights;
    this.adopt();
    if (props.itemWidth || props.heights) this.layout.invalidateLayout();
    if (props.speed != null) this.speed = props.speed;
    if (props.running != null) {
      this.running = !!props.running;
      if (this.running) this.start();
    }
  }

  dispose() {
    this.frame?.stop();
    this.frame = null;
  }

  /* ---------------------------------------------------------- recycling */

  private cellWithTag(tag: number): any {
    // The collection view is the only thing holding cells; ask it for the ones
    // on screen rather than keeping our own strong references.
    const cells = this.view.visibleCells;
    for (let i = 0; i < (cells ? cells.count : 0); i++) {
      const cell = cells.objectAtIndex(i);
      if (cell.tag === tag) return cell;
    }
    return null;
  }

  private cellFor(cv: any, indexPath: any): any {
    const cell = cv.dequeueReusableCellWithReuseIdentifierForIndexPath(
      'cell',
      indexPath
    );
    // Identify the cell by a tag of our own. React tags live in the same
    // namespace (Fabric stamps them on every mounted view), so start well past
    // anything RN will hand out.
    let tag = cell.tag;
    if (!tag) {
      tag = 900000 + ++this.cellSeq;
      cell.tag = tag;
    }
    const lines = items[indexPath.item]?.lines ?? 1;
    let slot = this.slotOfCell.get(tag);
    // A cell holding a template of the wrong height has to give it back.
    if (slot != null && this.shapes[slot] !== lines) {
      this.release(cell);
      slot = undefined;
    }
    if (slot == null) {
      // A free template if there is one; otherwise take the one held by the
      // cell that claimed longest ago — it is the furthest off screen. UIKit
      // asks for cells before it tells us the old ones are gone, so the pool
      // does run dry for a moment during a fast scroll, and a cell with no
      // template in it would be a visible hole.
      const next = (this.free.get(lines) ?? []).pop() ?? this.steal(lines);
      if (next == null) {
        return cell;
      }
      slot = next;
      this.slotOfCell.set(tag, slot);
      this.cellOfSlot.set(slot, tag);
      this.claimed.push(tag);
      this.park(slot, cell);
    }
    this.paint(slot, indexPath.item);
    return cell;
  }

  /** Move a template into a cell, and make sure it is the ONLY thing in there.
   *  A cell that comes back from the reuse queue still physically holds the
   *  template it had last time; leaving it would stack two rows on top of each
   *  other, which is exactly what a fast scroll makes visible. */
  private park(slot: number, cell: any): void {
    const root = slotFor(slot).root;
    const content = cell.contentView;
    const subviews = content.subviews;
    for (let i = (subviews ? subviews.count : 0) - 1; i >= 0; i--) {
      const view = subviews.objectAtIndex(i);
      if (view !== root) this.pool.addSubview(view);
    }
    content.addSubview(root);
  }

  private release(cell: any): void {
    const slot = this.slotOfCell.get(cell.tag);
    if (slot == null) return;
    this.slotOfCell.delete(cell.tag);
    this.cellOfSlot.delete(slot);
    this.claimed = this.claimed.filter((t) => t !== cell.tag);
    // Back to the pool, which takes it out of the cell it was in.
    this.pool.addSubview(slotFor(slot).root);
    slotFor(slot).row = -1;
    this.recycle(slot);
  }

  private recycle(slot: number): void {
    const lines = this.shapes[slot] ?? 1;
    const pool = this.free.get(lines) ?? [];
    pool.push(slot);
    this.free.set(lines, pool);
  }

  /** Reclaim the least recently claimed template OF THIS SHAPE. */
  private steal(lines: number): number | null {
    for (let i = 0; i < this.claimed.length; i++) {
      const victim = this.claimed[i]!;
      const slot = this.slotOfCell.get(victim);
      if (slot == null || this.shapes[slot] !== lines) continue;
      this.claimed.splice(i, 1);
      this.slotOfCell.delete(victim);
      this.cellOfSlot.delete(slot);
      return slot;
    }
    return null;
  }

  /** A row's height, from the shape its text needs. */
  private heightOf(row: number): number {
    const lines = items[row]?.lines ?? 1;
    return this.heights[lines - 1] ?? 150;
  }

  /** Write a row into a template. Six assignments, no allocation, no React. */
  private paint(index: number, row: number): void {
    const slot = slotFor(index);
    const item = items[row];
    if (!item || !slot.author) return;
    slot.row = row;
    slot.author.text = item.author;
    slot.meta.text = `${item.handle} · ${item.age}m`;
    slot.body.text = item.body;
    slot.detail.text = item.detail;
    slot.topic.text = item.topic;
    slot.art.image = art[item.art];
    slot.preview.image = art[item.preview];
    slot.face0.image = art[(item.art + 1) % ART_COUNT];
    slot.face1.image = art[(item.art + 7) % ART_COUNT];
    slot.face2.image = art[(item.art + 13) % ART_COUNT];
    this.live(slot, row);
  }

  /** The half that changes while the row is on screen. */
  private live(slot: Slot, row: number): void {
    const base = row * LIVE_STRIDE;
    this.painted++;
    const likes = live[base]!;
    slot.likes.text = `♥ ${compact(likes)}`;
    slot.replies.text = `↩ ${compact(live[base + 1]!)}`;
    slot.reposts.text = `⇅ ${compact(Math.floor(likes / 7))}`;
  }

  /* ------------------------------------------------------------- driving */

  private start(): void {
    if (this.frame) return;
    let last = Date.now();
    let offset = 0;
    this.frame = onEveryFrame(() => {
      const now = Date.now();
      const dt = Math.min(250, now - last) / 1000;
      last = now;
      this.frames++;

      // React mounts the templates a beat after the props arrive, and there is
      // no single event that says "all of them are up" — so keep asking until
      // they are. It stops the moment they have all been adopted.
      if (this.roots.length !== this.shapes.length) this.adopt();

      // Auto-scroll, so the recording shows recycling without a finger. Both
      // columns get the same offset from this one main-thread loop.
      // It scrolls at a sustained fling speed, which is where a list that
      // renders its rows on the JS thread runs out of runway.
      if (this.running) {
        const max = Math.max(
          0,
          this.view.contentSize.height - this.view.bounds.size.height
        );
        offset += this.speed * dt;
        if (offset > max) offset = 0;
        this.view.contentOffset = CGPointMake(0, offset);
        if (peerScroll) peerScroll.contentOffset = CGPointMake(0, offset);
      }

      // The header dot, on this thread's clock.
      for (const pulse of pulses) pulse.advance((now - this.since0) / 1000);

      // If React ever re-parents a template out of its cell, put it back.
      for (const [slot, tag] of this.cellOfSlot) {
        const root = slotFor(slot).root;
        if (!root || root.superview) continue;
        const cell = this.cellWithTag(tag);
        if (cell) this.park(slot, cell);
      }

      // Refresh the live counters of the rows actually on screen — read out of
      // the producer's shared memory, written into UILabels, on this thread.
      for (const [slot] of this.cellOfSlot) {
        const s = slotFor(slot);
        if (s.row >= 0 && s.likes) this.live(s, s.row);
      }

      if (now - this.since >= 500) {
        const secs = (now - this.since) / 1000;
        uiRate.value = Math.round(this.frames / secs);
        uiPatched.value = Math.round(this.painted / secs);
        this.frames = 0;
        this.painted = 0;
        this.since = now;
      }
    });
  }
}

registerComponents([WorkerFeed, WorkerText, WorkerArt, WorkerPulse]);
serveComponents();

const app: any = (globalThis as any).parent;

app.register('feed', {
  /**
   * Adopt the React list's scroll view, found by its React tag — Fabric stamps
   * every mounted view with it, so `viewWithTag:` and `findNodeHandle()` name
   * the same view and no UIManager is involved.
   */
  driveScroll(tag: number) {
    const window =
      UIApplication.sharedApplication.keyWindow ??
      UIApplication.sharedApplication.windows.objectAtIndex(0);
    const host = window ? window.viewWithTag(tag) : null;
    peerScroll = findScrollView(host);
    return !!peerScroll;
  },
});
