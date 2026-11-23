interface Slot<V> {
  readonly value: V;
  refs: number;
  reap: ReturnType<typeof setTimeout> | undefined;
}

export class Registry<V> {
  private readonly slots = new Map<string, Slot<V>>();

  constructor(
    private readonly drop: (key: string, value: V) => void,
    private readonly graceMs: number,
  ) {}

  get size(): number {
    return this.slots.size;
  }

  get(key: string): V | undefined {
    return this.slots.get(key)?.value;
  }

  values(): V[] {
    return [...this.slots.values()].map((s) => s.value);
  }

  peek(key: string, make: () => V): V {
    const slot = this.slot(key, make);
    if (slot.refs === 0) this.scheduleReap(key, slot);
    return slot.value;
  }

  retain(key: string, make: () => V): V {
    const slot = this.slot(key, make);
    slot.refs++;
    this.cancelReap(slot);
    return slot.value;
  }

  release(key: string): void {
    const slot = this.slots.get(key);
    if (!slot || slot.refs === 0) return;
    if (--slot.refs === 0) this.scheduleReap(key, slot);
  }

  forget(key: string, value: V): void {
    const slot = this.slots.get(key);
    if (slot?.value !== value) return;
    this.cancelReap(slot);
    this.slots.delete(key);
  }

  clear(): void {
    for (const slot of this.slots.values()) this.cancelReap(slot);
    this.slots.clear();
  }

  private slot(key: string, make: () => V): Slot<V> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { value: make(), refs: 0, reap: undefined };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private cancelReap(slot: Slot<V>): void {
    if (slot.reap) clearTimeout(slot.reap);
    slot.reap = undefined;
  }

  private scheduleReap(key: string, slot: Slot<V>): void {
    this.cancelReap(slot);
    slot.reap = setTimeout(() => {
      slot.reap = undefined;
      if (slot.refs > 0 || this.slots.get(key) !== slot) return;
      this.slots.delete(key);
      this.drop(key, slot.value);
    }, this.graceMs);
  }
}
