import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
const IMAGE_TTL_MS = 15 * 60_000;

function detectedImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", extension: ".png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", extension: ".jpg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", extension: ".webp" };
  }
  return null;
}

function sameTurn(left, right) {
  return (left || null) === (right || null);
}

function imageTypeFromName(name) {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg")) return "image/jpeg";
  return "image/webp";
}

export class ImageStore {
  constructor({ directory, ttlMs = IMAGE_TTL_MS } = {}) {
    this.directory = directory;
    this.ttlMs = ttlMs;
    this.records = new Map();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(entries.filter((entry) => entry.isFile() && /^phone-[a-f0-9-]+\.(?:png|jpg|webp)$/.test(entry.name)).map(async (entry) => {
      const imagePath = path.join(this.directory, entry.name);
      try {
        const details = await stat(imagePath);
        const expiresAtMs = details.mtimeMs + this.ttlMs;
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
          await unlink(imagePath).catch(() => {});
          return;
        }
        const id = entry.name.slice("phone-".length, entry.name.lastIndexOf("."));
        // A file restored after a service restart may already have been handed
        // to Codex. Keep it readable until expiry, but never make it reusable.
        this.records.set(id, {
          id,
          path: imagePath,
          mime: imageTypeFromName(entry.name),
          size: details.size,
          deviceId: null,
          sessionId: null,
          expectedTurnId: null,
          expiresAt: new Date(expiresAtMs).toISOString(),
          state: "leased",
          restored: true,
        });
      } catch {
        await unlink(imagePath).catch(() => {});
      }
    }));
  }

  async store({ buffer, deviceId, sessionId, expectedTurnId = null } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error("Image body is empty"), { statusCode: 400 });
    if (buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Image is larger than 6 MB"), { statusCode: 413 });
    const detected = detectedImage(buffer);
    if (!detected) throw Object.assign(new Error("Only JPEG, PNG, and WebP images are accepted"), { statusCode: 415 });
    const id = randomUUID();
    const finalPath = path.join(this.directory, `phone-${id}${detected.extension}`);
    const temporary = `${finalPath}.tmp-${process.pid}`;
    await writeFile(temporary, buffer, { mode: 0o600, flag: "wx" });
    await rename(temporary, finalPath);
    await chmod(finalPath, 0o600);
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const record = {
      id,
      path: finalPath,
      mime: detected.mime,
      size: buffer.length,
      deviceId,
      sessionId,
      expectedTurnId: expectedTurnId || null,
      expiresAt,
      state: "available",
    };
    this.records.set(id, record);
    return { id, mime: record.mime, size: record.size, expiresAt };
  }

  async consume(ids, { deviceId, sessionId, expectedTurnId = null } = {}) {
    const unique = Array.from(new Set(Array.isArray(ids) ? ids : []));
    if (unique.length > MAX_IMAGES_PER_MESSAGE) throw Object.assign(new Error("A message can include up to 4 images"), { statusCode: 400 });
    const records = unique.map((id) => this.records.get(id));
    if (records.some((record) => !record || record.state !== "available")) throw Object.assign(new Error("An uploaded image expired or was already used"), { statusCode: 409 });
    if (records.some((record) => record.deviceId !== deviceId || record.sessionId !== sessionId || !sameTurn(record.expectedTurnId, expectedTurnId))) {
      throw Object.assign(new Error("Uploaded image does not match this device, session, or turn"), { statusCode: 409 });
    }
    const leasedAt = new Date();
    await Promise.all(records.map((record) => utimes(record.path, leasedAt, leasedAt)));
    for (const record of records) {
      record.state = "leased";
      record.expiresAt = new Date(leasedAt.getTime() + this.ttlMs).toISOString();
    }
    return records;
  }

  async discard(id, deviceId = null, { force = false } = {}) {
    const record = this.records.get(id);
    if (!record || (deviceId && record.deviceId !== deviceId) || (!force && record.state !== "available")) return false;
    this.records.delete(id);
    await unlink(record.path).catch(() => {});
    return true;
  }

  async discardRecords(records = []) {
    await Promise.all(records.map(async (record) => {
      this.records.delete(record.id);
      await unlink(record.path).catch(() => {});
    }));
  }

  async cleanup() {
    const now = Date.now();
    await this.discardRecords(Array.from(this.records.values()).filter((record) => Date.parse(record.expiresAt) <= now));
  }

  async close() {
    // Unsubmitted uploads are safe to remove. Leased files may still be read
    // asynchronously by Codex, so preserve them across a service restart.
    const records = Array.from(this.records.values()).filter((record) => record.state === "available");
    await this.discardRecords(records);
    this.records.clear();
  }
}
