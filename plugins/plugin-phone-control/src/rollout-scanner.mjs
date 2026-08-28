import { EventEmitter } from "node:events";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createRolloutContext, normalizeRolloutRecord } from "./rollout-parser.mjs";

const INITIAL_HEAD_BYTES = 128 * 1024;
const INITIAL_TAIL_BYTES = 1024 * 1024;
const MAX_INCREMENTAL_BYTES = 2 * 1024 * 1024;

async function findJsonlFiles(root, output = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return output;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await findJsonlFiles(target, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
  }
  return output;
}

async function readRange(filePath, start, length) {
  if (length <= 0) return "";
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseLines(text, context, emit, { skipFirstPartial = false } = {}) {
  const lines = text.split("\n");
  if (skipFirstPartial) lines.shift();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      for (const event of normalizeRolloutRecord(record, context)) emit(event);
    } catch {
      // Ignore truncated or future-format records; the scanner remains live.
    }
  }
}

export class RolloutScanner extends EventEmitter {
  constructor({ sessionsDir, intervalMs = 1_500, maxFiles = 200 } = {}) {
    super();
    this.sessionsDir = sessionsDir;
    this.intervalMs = intervalMs;
    this.maxFiles = maxFiles;
    this.files = new Map();
    this.timer = null;
    this.running = false;
    this.scanning = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scanOnce() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const candidates = [];
      for (const filePath of await findJsonlFiles(this.sessionsDir)) {
        try {
          const details = await stat(filePath);
          candidates.push({ filePath, size: details.size, mtimeMs: details.mtimeMs });
        } catch {
          // The file may rotate between discovery and stat.
        }
      }
      candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
      for (const candidate of candidates.slice(0, this.maxFiles)) {
        await this.scanFile(candidate);
      }
    } catch (error) {
      this.emit("warning", error);
    } finally {
      this.scanning = false;
    }
  }

  async scanFile(candidate) {
    const known = this.files.get(candidate.filePath);
    if (!known || candidate.size < known.offset) {
      const context = createRolloutContext(candidate.filePath);
      const headLength = Math.min(candidate.size, INITIAL_HEAD_BYTES);
      parseLines(await readRange(candidate.filePath, 0, headLength), context, () => {});

      const tailStart = Math.max(headLength, candidate.size - INITIAL_TAIL_BYTES);
      const events = [];
      if (candidate.size <= headLength) {
        parseLines(await readRange(candidate.filePath, 0, candidate.size), context, (event) => events.push(event));
      } else {
        parseLines(
          await readRange(candidate.filePath, tailStart, candidate.size - tailStart),
          context,
          (event) => events.push(event),
          { skipFirstPartial: tailStart > 0 },
        );
      }
      for (const event of events.slice(-120)) this.emit("event", event);
      this.files.set(candidate.filePath, { offset: candidate.size, context, remainder: "" });
      return;
    }
    if (candidate.size === known.offset) return;

    let start = known.offset;
    let skipFirstPartial = false;
    if (candidate.size - start > MAX_INCREMENTAL_BYTES) {
      start = candidate.size - MAX_INCREMENTAL_BYTES;
      known.remainder = "";
      skipFirstPartial = true;
    }
    const chunk = await readRange(candidate.filePath, start, candidate.size - start);
    let text = `${known.remainder}${chunk}`;
    if (skipFirstPartial) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    known.remainder = lines.pop() || "";
    parseLines(lines.join("\n"), known.context, (event) => this.emit("event", event));
    known.offset = candidate.size;
  }
}

export { findJsonlFiles };
