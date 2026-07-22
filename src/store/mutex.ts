/**
 * A minimal async mutex. better-sqlite3 is synchronous, but a write's
 * SQLite-commit -> Lance-add pair straddles an `await`, so two concurrent writes
 * could interleave their SQLite and Lance halves. Serializing every write through
 * this mutex preserves the single-writer, SQLite-first ordering across the await.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively; calls are serialized in invocation order. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
