/**
 * Fixed-capacity circular buffer. Used to hold a bounded window of the most
 * recent samples (frames, events) so boundary detection can look back cheaply
 * without unbounded memory. Oldest items are overwritten once full.
 */
export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private head = 0; // index of the next write
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** Push an item; returns the evicted item if the buffer was full. */
  push(item: T): T | undefined {
    let evicted: T | undefined;
    if (this.isFull) evicted = this.buf[this.head];
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return evicted;
  }

  /** Most recently pushed item, or undefined if empty. */
  last(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buf[(this.head - 1 + this.capacity) % this.capacity];
  }

  /** Oldest retained item, or undefined if empty. */
  first(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buf[(this.head - this.count + this.capacity) % this.capacity];
  }

  /** Contents oldest -> newest. */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(start + i) % this.capacity] as T;
    }
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buf.fill(undefined);
  }
}
