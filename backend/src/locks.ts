export class KeyedLocks {
  async runMany<T>(keys: string[], task: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const next = (index: number): Promise<T> =>
      index === ordered.length ? task() : this.run(ordered[index], () => next(index + 1));
    return next(0);
  }
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
