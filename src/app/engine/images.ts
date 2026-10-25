// Decoded snapshot images for the far (mosaic) tier, with a size-bounded LRU so memory stays flat with 1000+ screens.
const cache = new Map<string, HTMLImageElement>();
const MAX = 2500;
let onLoad: (() => void) | undefined;
let pendingNotify = false;

export function onImageLoad(fn: () => void) {
  onLoad = fn;
}

/** New image requests allowed in this frame; the rest show their average colour until a later frame. */
let budget = 40;
let deferred = false;
export function beginFrame(n = 40) {
  budget = n;
  deferred = false;
}
/** True when some images were held back this frame (the caller schedules another frame). */
export function wasDeferred() {
  return deferred;
}

export function image(url: string): HTMLImageElement | undefined {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit);
    return hit.complete && hit.naturalWidth ? hit : undefined;
  }
  if (budget <= 0) {
    deferred = true;
    return undefined;
  }
  budget--;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  img.onload = () => {
    if (pendingNotify) return;
    pendingNotify = true;
    requestAnimationFrame(() => {
      pendingNotify = false;
      onLoad?.();
    });
  };
  cache.set(url, img);
  while (cache.size > MAX) {
    const k = cache.keys().next().value!;
    const old = cache.get(k)!;
    old.src = '';
    cache.delete(k);
  }
  return undefined;
}
