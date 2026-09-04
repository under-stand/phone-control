import assert from "node:assert/strict";
import {
  createConnectionState,
  isStreamHealthy,
  reduceConnectionState,
} from "../public/lib/connection-state.js";

export const tests = [
  {
    name: "prefers the live stream while retaining HTTP freshness during reconnect",
    async run() {
      const initial = createConnectionState({ now: 1_000 });
      const connecting = reduceConnectionState(initial, { type: "connect_start" }, { now: 1_100 });
      const open = reduceConnectionState(connecting, { type: "stream_open" }, { now: 1_200 });
      const online = reduceConnectionState(open, { type: "stream_snapshot" }, { now: 1_300 });
      assert.equal(online.phase, "online");
      assert.equal(online.transport, "sse");
      assert.equal(isStreamHealthy(online, { now: 10_000, maxAgeMs: 36_000 }), true);

      const failed = reduceConnectionState(online, { type: "stream_error", error: "socket closed" }, { now: 11_000, httpFreshMs: 20_000 });
      assert.equal(failed.phase, "synced");
      assert.equal(failed.transport, "none");
      assert.equal(failed.lastError, "socket closed");
    },
  },
  {
    name: "marks a connection stale only after both transports lose freshness",
    async run() {
      let state = createConnectionState({ now: 0 });
      state = reduceConnectionState(state, { type: "stream_snapshot" }, { now: 1_000 });
      state = reduceConnectionState(state, { type: "stream_stale" }, { now: 25_000, httpFreshMs: 20_000 });
      assert.equal(state.phase, "connecting");
      state = reduceConnectionState(state, { type: "background" }, { now: 30_000 });
      assert.equal(state.phase, "paused");
      state = reduceConnectionState(state, { type: "foreground" }, { now: 31_000 });
      assert.equal(state.phase, "connecting");
      assert.equal(state.backgroundedAt, 0);

      state = reduceConnectionState(state, { type: "stream_snapshot" }, { now: 32_000 });
      state = reduceConnectionState(state, { type: "foreground" }, { now: 33_000 });
      assert.equal(state.phase, "online");
    },
  },
];
