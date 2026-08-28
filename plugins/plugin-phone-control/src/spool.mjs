import { appendFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_SPOOL_BYTES = 4 * 1024 * 1024;

export async function appendSpool(filePath, event) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    if ((await stat(filePath)).size >= MAX_SPOOL_BYTES) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await appendFile(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return true;
}

export async function drainSpool(filePath, onEvent) {
  const drainPath = `${filePath}.drain-${process.pid}-${Date.now()}`;
  try {
    await rename(filePath, drainPath);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  let count = 0;
  try {
    const content = await readFile(drainPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        await onEvent(event);
        count += 1;
      } catch {
        // A broken row must not block later hook events.
      }
    }
    return count;
  } finally {
    await unlink(drainPath).catch(() => {});
  }
}
