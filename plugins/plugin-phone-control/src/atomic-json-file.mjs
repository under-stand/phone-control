import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export class AtomicJsonFile {
  constructor(filePath) {
    this.filePath = filePath;
    this.tail = Promise.resolve();
  }

  write(value) {
    const body = JSON.stringify(value);
    const result = this.tail.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async flush() { await this.tail; }
}
