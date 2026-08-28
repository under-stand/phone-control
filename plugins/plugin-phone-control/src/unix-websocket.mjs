import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Writable } from "node:stream";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HANDSHAKE_BYTES = 64 * 1024;
// Match the bounded envelope used by the official remote App Server client.
// Phone Control requests metadata-only resumes, so this is a defense-in-depth
// ceiling for unexpectedly large live notifications rather than a history
// transport budget.
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

function sizeError(kind, actualBytes) {
  return Object.assign(new Error(
    `WebSocket ${kind} is too large (${actualBytes} bytes; limit ${MAX_FRAME_BYTES})`,
  ), {
    code: "ERR_WS_MESSAGE_TOO_LARGE",
    actualBytes,
    maxBytes: MAX_FRAME_BYTES,
  });
}

function frame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) throw sizeError("payload", body.length);
  const extended = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  if (!extended) header[1] = 0x80 | body.length;
  else if (extended === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, masked]);
}

function websocketAccept(key) {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function headerValue(text, name) {
  const line = text.split("\r\n").find((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

class BufferQueue {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
  }

  push(chunk) {
    if (!chunk?.length) return;
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(value);
    this.length += value.length;
  }

  peek(length) {
    if (length > this.length) return null;
    const first = this.chunks[0];
    const available = first.length - this.offset;
    if (available >= length) return first.subarray(this.offset, this.offset + length);
    const result = Buffer.allocUnsafe(length);
    let copied = 0;
    let chunkIndex = 0;
    let chunkOffset = this.offset;
    while (copied < length) {
      const chunk = this.chunks[chunkIndex];
      const take = Math.min(length - copied, chunk.length - chunkOffset);
      chunk.copy(result, copied, chunkOffset, chunkOffset + take);
      copied += take;
      chunkIndex += 1;
      chunkOffset = 0;
    }
    return result;
  }

  discard(length) {
    if (length > this.length) throw new Error("WebSocket parser buffer underflow");
    this.length -= length;
    let remaining = length;
    while (remaining > 0) {
      const available = this.chunks[0].length - this.offset;
      if (remaining < available) {
        this.offset += remaining;
        return;
      }
      remaining -= available;
      this.chunks.shift();
      this.offset = 0;
    }
  }

  read(length) {
    if (length > this.length) return null;
    const first = this.chunks[0];
    const available = first.length - this.offset;
    if (available >= length) {
      const result = Buffer.from(first.subarray(this.offset, this.offset + length));
      this.discard(length);
      return result;
    }
    const result = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const chunk = this.chunks[0];
      const take = Math.min(length - copied, chunk.length - this.offset);
      chunk.copy(result, copied, this.offset, this.offset + take);
      copied += take;
      this.discard(take);
    }
    return result;
  }
}

function createFrameParser(socket, readable) {
  const queue = new BufferQueue();
  let fragments = [];
  let fragmentedOpcode = null;
  let fragmentedBytes = 0;

  function deliver(opcode, payload, final) {
    if (opcode === 0x8) {
      if (!socket.destroyed) socket.end(frame(payload.slice(0, 125), 0x8));
      return;
    }
    if (opcode === 0x9) {
      if (!socket.destroyed) socket.write(frame(payload.slice(0, 125), 0xA));
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x0) {
      if (fragmentedOpcode == null) throw new Error("Unexpected WebSocket continuation frame");
      fragmentedBytes += payload.length;
      if (fragmentedBytes > MAX_FRAME_BYTES) throw sizeError("message", fragmentedBytes);
      fragments.push(payload);
      if (!final) return;
      const complete = Buffer.concat(fragments);
      const originalOpcode = fragmentedOpcode;
      fragments = [];
      fragmentedOpcode = null;
      fragmentedBytes = 0;
      if (originalOpcode === 0x1) readable.write(`${complete.toString("utf8")}\n`);
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x2) throw new Error(`Unsupported WebSocket opcode ${opcode}`);
    if (!final) {
      fragmentedOpcode = opcode;
      fragments = [payload];
      fragmentedBytes = payload.length;
      return;
    }
    if (opcode === 0x1) readable.write(`${payload.toString("utf8")}\n`);
  }

  return (chunk) => {
    queue.push(chunk);
    while (queue.length >= 2) {
      const basicHeader = queue.peek(2);
      const first = basicHeader[0];
      const second = basicHeader[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (queue.length < 4) return;
        length = queue.peek(4).readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (queue.length < 10) return;
        const large = queue.peek(10).readBigUInt64BE(2);
        if (large > BigInt(MAX_FRAME_BYTES)) throw sizeError("frame", large.toString());
        length = Number(large);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) throw sizeError("frame", length);
      const maskBytes = masked ? 4 : 0;
      const headerBytes = offset + maskBytes;
      if (queue.length < headerBytes + length) return;
      const header = queue.peek(headerBytes);
      const mask = masked ? Buffer.from(header.subarray(offset, offset + 4)) : null;
      queue.discard(headerBytes);
      const payload = queue.read(length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      deliver(opcode, payload, final);
    }
  };
}

export function connectUnixWebSocket(socketPath, { handshakeTimeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const key = randomBytes(16).toString("base64");
    let handshake = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Timed out connecting to the managed Codex app-server")), handshakeTimeoutMs);
    timer.unref?.();

    function finish(error, transport) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onInitialError);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(transport);
    }

    function onInitialError(error) {
      finish(error);
    }

    socket.once("error", onInitialError);
    socket.once("connect", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const onHandshakeData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      if (handshake.length > MAX_HANDSHAKE_BYTES) {
        finish(new Error("Managed app-server returned an oversized WebSocket handshake"));
        return;
      }
      const end = handshake.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onHandshakeData);
      const head = handshake.subarray(0, end).toString("utf8");
      const remainder = handshake.subarray(end + 4);
      if (!/^HTTP\/1\.[01] 101\b/.test(head)) {
        finish(new Error(`Managed app-server rejected WebSocket connection: ${head.split("\r\n")[0] || "unknown response"}`));
        return;
      }
      if (headerValue(head, "sec-websocket-accept") !== websocketAccept(key)) {
        finish(new Error("Managed app-server returned an invalid WebSocket accept header"));
        return;
      }

      const readable = new PassThrough();
      const writable = new Writable({
        write(chunkToWrite, encoding, callback) {
          let text = Buffer.isBuffer(chunkToWrite) ? chunkToWrite.toString("utf8") : String(chunkToWrite);
          text = text.replace(/\n$/, "");
          if (!text) {
            callback();
            return;
          }
          try {
            socket.write(frame(text), callback);
          } catch (error) {
            callback(error);
          }
        },
      });
      const parseFrame = createFrameParser(socket, readable);
      socket.on("data", (data) => {
        try { parseFrame(data); } catch (error) {
          readable.destroy(error);
          writable.destroy(error);
          socket.destroy(error);
        }
      });
      if (remainder.length) {
        try { parseFrame(remainder); } catch (error) {
          finish(error);
          return;
        }
      }
      const closed = new Promise((closedResolve) => {
        socket.once("close", () => closedResolve({ code: null, signal: null }));
        socket.once("error", (error) => closedResolve({ error }));
      });
      socket.on("error", (error) => {
        readable.destroy(error);
        writable.destroy(error);
      });
      socket.once("close", () => {
        readable.end();
        writable.destroy();
      });
      finish(null, {
        readable,
        writable,
        closed,
        close() {
          if (!socket.destroyed) socket.end(frame(Buffer.alloc(0), 0x8));
        },
      });
    };
    socket.on("data", onHandshakeData);
  });
}

export {
  MAX_FRAME_BYTES,
  createFrameParser,
  frame as encodeWebSocketFrame,
};
