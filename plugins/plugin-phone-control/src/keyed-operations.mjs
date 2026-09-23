// Serialize only operations that share a session. A slow remote response must
// not hold the journal writer or operations for another session.
export class KeyedOperations {
  constructor() { this.tails = new Map(); }

  run(key, operation) {
    const result = (this.tails.get(key) || Promise.resolve()).then(operation);
    const tail = result.then(() => {}, () => {}).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.tails.set(key, tail);
    return result;
  }

  async flush() {
    while (this.tails.size) await Promise.all([...this.tails.values()]);
  }
}

export async function forEachConcurrent(items, concurrency, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await operation(items[next++]);
  }));
}
