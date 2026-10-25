// A tiny observable store. The canvas engine subscribes imperatively; React reads it with useSyncExternalStore.
import { useSyncExternalStore } from 'react';

export class Store<T extends object> {
  private state: T;
  private subs = new Set<() => void>();
  constructor(initial: T) {
    this.state = initial;
  }
  get = (): T => this.state;
  set = (patch: Partial<T> | ((s: T) => Partial<T>)) => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof T)[]) if (this.state[k] !== p[k]) changed = true;
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const fn of [...this.subs]) fn();
  };
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
}

export function useStore<T extends object, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
