# Connectivity and responsiveness audit — 2026-08-27

## Verdict

The Phone Control service is healthy and fast on the host. The dominant source of perceived
instability is the current phone-to-host Tailscale route, which cannot establish a direct path and
falls back to a high-latency DERP relay. The browser connection state machine then amplifies short
transport interruptions by visibly cycling through retry, sync, and live labels.

## Evidence

- Local `/api/health`: HTTP 200, about 1 ms total.
- Tailscale HTTPS `/api/health`: 24/24 successful samples; about 71–86 ms total from the host,
  including TLS. MagicDNS added about 4 ms and did not fail during this sample.
- Public SSE: stayed open for 25 seconds, delivered the initial snapshot and two 12-second
  heartbeats, and did not end early.
- Host-to-phone Tailscale ping: direct connection was not established. The phone was reached via
  `DERP(tok)`; 9 replies ranged from 656 ms to 1.567 seconds and one of ten probes timed out.
- Tailscale daemon: running since 2026-08-25 01:58 CST with no reported health warnings.
- Phone Control process: running since 2026-08-27 09:56 CST, about 0.3% CPU and 89 MiB RSS during
  the audit. The tmux restart loop and managed `@reboot` crontab entry were both present.
- Current compressed payloads through the HTTPS entry:
  - HTML shell: 3.4 KiB
  - JavaScript: 37.6 KiB
  - CSS: 12.1 KiB
  - 17-session list: 10.3 KiB
  - Initial 72-event detail: 13.2 KiB
  - Largest 240-event detail: 37.5 KiB

The payloads and server processing time are small enough that mobile latency is dominated by the
relay round trip, not by response generation or transfer size.

## Root causes

1. **Network path:** the host and Android phone cannot negotiate a direct Tailscale connection, so
   every interactive round trip traverses a DERP relay. The observed timeout and 0.6–1.6 second
   round trips explain slow foreground recovery and occasional SSE reconnects.
2. **UI amplification:** `EventSource` errors immediately triggered a fallback snapshot and visible
   label transitions. Android lifecycle events (`visibilitychange`, `resume`, `pageshow`, and
   `online`) could also arrive close together and rebuild an already healthy stream more than once.
3. **Not a current service failure:** the local service, Tailscale daemon, Serve route, heartbeat,
   and restart mechanisms were all healthy during the audit.

## Implemented response

- A healthy SSE connection is reused across duplicate lifecycle signals.
- A foreground lifecycle burst shares one recovery transaction and one session snapshot.
- Fresh live state receives a 12-second transient-loss grace period, so brief packet loss no longer
  produces a retry/sync/live flicker.
- If SSE remains unavailable but HTTP snapshots work, the UI degrades to `已同步`; it reports
  recovery/retry only when the live data is actually stale.
- The unreliable Android `navigator.onLine` signal no longer directly marks the machine offline.
- Manual reconnect still bypasses the grace period and performs an explicit fresh probe.

## Remaining limits and next architecture step

UI hysteresis can remove false alarms, but it cannot reduce a 0.6–1.6 second DERP round trip. The
largest future latency improvement is a standard HTTPS relay near the phone and host (or a network
change that enables a direct Tailscale path). That relay should preserve the current per-device
credentials, end-to-end request binding, short-lived image leases, and local-only Codex App Server;
it should never expose the host HTTP service directly to the public internet.

The accepted visual and interaction audit is available at
`artifacts/connectivity-stability-v47-audit/AUDIT.md`. It contains the current-run mobile captures,
step-by-step findings, accessibility evidence limits, and the final regression result.
