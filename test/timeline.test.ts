import { describe, expect, it } from "vitest";
import { MonotonicClock } from "../src/timeline/clock.js";
import { RingBuffer } from "../src/timeline/ring-buffer.js";
import { isMonotonic, mergeSortedByTMono } from "../src/timeline/sync.js";

describe("MonotonicClock", () => {
  it("measures t_mono as elapsed monotonic ms from the epoch, not wall-clock", () => {
    let mono = 5000;
    const clock = MonotonicClock.start(() => mono, () => 1_700_000_000_000);
    expect(clock.epochMono).toBe(5000);
    expect(clock.startedAt).toBe(1_700_000_000_000);
    mono = 5001;
    expect(clock.now()).toBe(1);
    mono = 5250;
    expect(clock.now()).toBe(250);
  });

  it("is immune to wall-clock jumps (t_mono keeps advancing monotonically)", () => {
    let mono = 100;
    let wall = 1000;
    const clock = MonotonicClock.start(() => mono, () => wall);
    mono = 200;
    wall = 0; // wall clock steps BACKWARD (NTP/DST) ...
    expect(clock.now()).toBe(100); // ... t_mono is unaffected
  });

  it("converts between t_mono and wall for display", () => {
    const clock = MonotonicClock.start(() => 0, () => 1000);
    expect(clock.wallAt(250)).toBe(1250);
    expect(clock.toMono(1250)).toBe(250);
  });

  it("resume() keeps t_mono continuous with a persisted epoch", () => {
    let mono = 9000;
    const clock = MonotonicClock.resume(1000, 8000, () => mono);
    mono = 8500;
    expect(clock.now()).toBe(500);
  });
});

describe("RingBuffer", () => {
  it("overwrites oldest when full and reports order oldest->newest", () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.push(1)).toBeUndefined();
    rb.push(2);
    rb.push(3);
    expect(rb.isFull).toBe(true);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    expect(rb.push(4)).toBe(1); // evicts oldest
    expect(rb.toArray()).toEqual([2, 3, 4]);
    expect(rb.first()).toBe(2);
    expect(rb.last()).toBe(4);
    expect(rb.length).toBe(3);
  });

  it("clear resets and rejects bad capacity", () => {
    const rb = new RingBuffer<string>(2);
    rb.push("a");
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.last()).toBeUndefined();
    expect(() => new RingBuffer<number>(0)).toThrow();
  });
});

describe("mergeSortedByTMono", () => {
  it("k-way merges pre-sorted streams into one ascending timeline", () => {
    const clicks = [{ tMono: 1, k: "click" }, { tMono: 5, k: "click" }];
    const keys = [{ tMono: 2, k: "key" }, { tMono: 3, k: "key" }];
    const scroll = [{ tMono: 4, k: "scroll" }];
    const merged = mergeSortedByTMono([clicks, keys, scroll]);
    expect(merged.map((m) => m.tMono)).toEqual([1, 2, 3, 4, 5]);
    expect(isMonotonic(merged)).toBe(true);
  });

  it("breaks t_mono ties by stream order (stable)", () => {
    const a = [{ tMono: 1, s: "a" }];
    const b = [{ tMono: 1, s: "b" }];
    expect(mergeSortedByTMono([a, b]).map((m) => m.s)).toEqual(["a", "b"]);
  });
});
