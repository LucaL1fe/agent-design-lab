// Pan and zoom: one transform on the world element, written at most once per frame. React never renders while the
// view moves. Trackpad: two-finger scroll pans, pinch (ctrl+wheel) zooms around the cursor; Safari gesture events;
// touch pinch; space/middle-button/hand-tool drag. Gesture state lets the renderer hold expensive work until the
// view settles.
import type { Rect } from '../../core/types.ts';

export interface View {
  x: number;
  y: number;
  k: number;
}

export const MIN_K = 0.02;
export const MAX_K = 4;
export const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export type GesturePhase = 'idle' | 'active' | 'settling';

export class Viewport {
  readonly el: HTMLElement;
  readonly world: HTMLElement;
  v: View = { x: 0, y: 0, k: 0.25 };
  phase: GesturePhase = 'idle';
  private raf = 0;
  private settleT = 0;
  private animT = 0;
  private listeners = new Set<(v: View, phase: GesturePhase) => void>();
  private ac = new AbortController();
  /** Panning by dragging (hand tool, space or middle button). */
  private pan: { x: number; y: number; vx: number; vy: number; id: number } | undefined;
  private pinch: { d: number; k: number } | undefined;
  private ptrs = new Map<number, { x: number; y: number }>();
  space = false;
  handTool = false;
  /** Top inset (toolbar) so "fit" leaves room for the floating chrome. */
  insetTop = 64;
  /** Right inset (the side panel when it is open). */
  insetRight = 0;
  private reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(el: HTMLElement, world: HTMLElement) {
    this.el = el;
    this.world = world;
    const on = { signal: this.ac.signal };
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, signal: this.ac.signal });
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e), on);
    el.addEventListener('pointermove', (e) => this.onPointerMove(e), on);
    el.addEventListener('pointerup', (e) => this.onPointerUp(e), on);
    el.addEventListener('pointercancel', (e) => this.onPointerUp(e), on);
    el.addEventListener('gesturestart', (e) => this.onGesture(e as GestureEventLike, true), on);
    el.addEventListener('gesturechange', (e) => this.onGesture(e as GestureEventLike, false), on);
    el.addEventListener(
      'scroll',
      () => {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      },
      on,
    );
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Space' && !isTyping()) {
          if (!this.space) this.el.classList.add('space');
          this.space = true;
          if (e.target === document.body) e.preventDefault();
        }
      },
      on,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.code === 'Space') {
          this.space = false;
          this.el.classList.remove('space');
        }
      },
      on,
    );
    window.addEventListener('resize', () => this.changed(false), on);
  }

  destroy() {
    this.ac.abort();
    cancelAnimationFrame(this.raf);
  }

  on(fn: (v: View, phase: GesturePhase) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mark the view as changed; `gesture` keeps the phase active until input stops. */
  changed(gesture = true) {
    if (gesture) {
      this.phase = 'active';
      clearTimeout(this.settleT);
      this.settleT = window.setTimeout(() => {
        this.phase = 'settling';
        this.flush();
        window.setTimeout(() => {
          if (this.phase === 'settling') {
            this.phase = 'idle';
            this.emit();
          }
        }, 30);
      }, 150);
    }
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const { x, y, k } = this.v;
    // whole device pixels when the view is still, for crisp text
    const dpr = devicePixelRatio || 1;
    const sx = this.phase === 'active' ? x : Math.round(x * dpr) / dpr;
    const sy = this.phase === 'active' ? y : Math.round(y * dpr) / dpr;
    this.world.style.transform = `translate(${sx}px, ${sy}px) scale(${k})`;
    this.emit();
  }

  private emit() {
    for (const l of [...this.listeners]) l(this.v, this.phase);
  }

  set(v: View, opts: { animate?: boolean; gesture?: boolean } = {}) {
    this.v = { x: v.x, y: v.y, k: clampK(v.k) };
    if (opts.animate && !this.reduceMotion) {
      this.world.classList.add('animating');
      clearTimeout(this.animT);
      this.animT = window.setTimeout(() => this.world.classList.remove('animating'), 420);
    }
    this.changed(opts.gesture ?? false);
  }

  zoomAt(px: number, py: number, k: number, gesture = true) {
    const nk = clampK(k);
    const wx = (px - this.v.x) / this.v.k;
    const wy = (py - this.v.y) / this.v.k;
    this.v = { k: nk, x: px - wx * nk, y: py - wy * nk };
    this.changed(gesture);
  }

  zoomBy(f: number) {
    this.world.classList.add('animating');
    clearTimeout(this.animT);
    this.animT = window.setTimeout(() => this.world.classList.remove('animating'), 420);
    this.zoomAt(
      (this.el.clientWidth - this.insetRight) / 2,
      (this.el.clientHeight + this.insetTop) / 2,
      this.v.k * f,
      false,
    );
  }

  fitRect(r: Rect, opts: { pad?: number; maxK?: number; animate?: boolean } = {}) {
    const pad = opts.pad ?? 48;
    const W = this.el.clientWidth - this.insetRight;
    const H = this.el.clientHeight - this.insetTop;
    if (r.w <= 0 || r.h <= 0 || W <= 0 || H <= 0) return;
    const k = clampK(Math.min((W - pad * 2) / r.w, (H - pad * 2) / r.h, opts.maxK ?? 1));
    this.set(
      { k, x: (W - r.w * k) / 2 - r.x * k, y: this.insetTop + (H - r.h * k) / 2 - r.y * k },
      { animate: opts.animate ?? true },
    );
  }

  /** World rectangle currently visible. */
  visibleRect(margin = 0): Rect {
    const { x, y, k } = this.v;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    return { x: (-x - margin) / k, y: (-y - margin) / k, w: (w + 2 * margin) / k, h: (h + 2 * margin) / k };
  }

  toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.v.x) / this.v.k, (clientY - r.top - this.v.y) / this.v.k];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [wx * this.v.k + this.v.x, wy * this.v.k + this.v.y];
  }

  private onWheel(e: WheelEvent) {
    if ((e.target as Element).closest?.('.adl-allow-scroll')) return;
    e.preventDefault();
    this.world.classList.remove('animating');
    const r = this.el.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // trackpad pinch arrives as ctrl+wheel; mouse wheel + ⌘/ctrl zooms too
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.v.k * Math.exp(-dy * 0.0045));
      return;
    }
    const f = e.deltaMode === 1 ? 16 : 1;
    let dx = e.deltaX * f;
    let dy = e.deltaY * f;
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    this.v = { ...this.v, x: this.v.x - dx, y: this.v.y - dy };
    this.changed();
  }

  /** Begin a drag-pan from a pointer event (called by the interaction layer, or by the viewport itself). */
  startPan(e: PointerEvent) {
    this.el.setPointerCapture(e.pointerId);
    this.pan = { x: e.clientX, y: e.clientY, vx: this.v.x, vy: this.v.y, id: e.pointerId };
    this.el.classList.add('panning');
    this.world.classList.remove('animating');
  }

  get panning() {
    return !!this.pan || !!this.pinch;
  }

  private onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.v.k };
        this.pan = undefined;
        e.stopPropagation();
        return;
      }
    }
    if (e.button === 1 || ((this.space || this.handTool) && e.button === 0)) {
      e.preventDefault();
      e.stopPropagation();
      this.startPan(e);
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const r = this.el.getBoundingClientRect();
      this.zoomAt(
        (a.x + b.x) / 2 - r.left,
        (a.y + b.y) / 2 - r.top,
        this.pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d),
      );
      return;
    }
    if (this.pan && e.pointerId === this.pan.id) {
      this.v = { ...this.v, x: this.pan.vx + (e.clientX - this.pan.x), y: this.pan.vy + (e.clientY - this.pan.y) };
      this.changed();
    }
  }

  private onPointerUp(e: PointerEvent) {
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2) this.pinch = undefined;
    if (this.pan && e.pointerId === this.pan.id) {
      this.pan = undefined;
      this.el.classList.remove('panning');
    }
  }

  private gk = 1;
  private onGesture(e: GestureEventLike, start: boolean) {
    e.preventDefault();
    if (start) {
      this.gk = this.v.k;
      return;
    }
    const r = this.el.getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.gk * e.scale);
  }
}

interface GestureEventLike extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

/**
 * Where a section title goes, in screen px: it sticks to the left edge while the section runs off-screen,
 * but never past the section's right edge, so it can't run over the next section's title.
 */
export function stickyTitle(x: number, w: number, edge = 8, min = 120): { left: number; room: number } {
  const left = Math.round(Math.max(x, Math.min(x + w - min, edge)));
  return { left, room: x + w - left };
}

export function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}
