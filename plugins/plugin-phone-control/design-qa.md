# Mobile design QA

## Current accepted audit

- Connectivity and usability audit: `artifacts/connectivity-stability-v47-audit/AUDIT.md`
- Current captures: `artifacts/connectivity-stability-v47-audit/`
- Viewport: `412 × 915` CSS px at `deviceScaleFactor: 1`
- Result: 15 core states plus keyboard viewport, zero unexpected browser errors.
- Connection lifecycle bursts reuse one healthy stream or one recovery request; short network
  transitions keep the fresh live state stable.
- Empty device pairing controls now remain hidden until a link is generated.

## Previous comparison target

- Existing product baseline: `artifacts/full-audit-2026-08-26/`
- Current implementation: `artifacts/stabilization-v41/`
- Combined comparison: `artifacts/stabilization-v41/comparison.png`
- Viewport: `412 × 915` CSS px at `deviceScaleFactor: 1`
- Compared states: new-session form, per-session runtime settings, and device management.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- The new-session primary action stays visible in a short viewport while the project and runtime controls scroll independently.
- Per-session runtime settings now use an independent bottom sheet. The parent task detail remains visible behind it and exposes only one close action at a time.
- Device management shows active devices first and moves bounded revoked records into a collapsed archive with an explicit purge action.
- The established warm-neutral palette, spacing scale, type hierarchy, icon assets, radii, and sheet behavior are preserved.
- The audit container lacks a CJK font, so screenshot glyphs render as fallback boxes; production phones use the system CJK font. Layout metrics, control sizes, hierarchy, and overflow behavior remain inspectable.

## Interaction and boundary coverage

- 15 mobile states captured with zero unexpected browser errors.
- Draft text and image attachments survive reconnects, background/resume, and composer collapse.
- A deliberately delayed detail response cannot replace a focused continuation input or dismiss the mobile keyboard.
- An overlay-style Android keyboard reduces and offsets the visual viewport; the detail sheet, focused composer, and send action remain entirely above its edge, including a 360px-tall visual viewport.
- Healthy SSE avoids full-list polling; explicit reconnect and offline recovery work.
- Manual reconnect reports live only after its first session snapshot, ignores slower stale list responses, and preserves an opened conversation DOM through late control-state stabilization.
- Reminder toggles acknowledge taps immediately, stay interactive, and reconcile browser/server subscriptions in one background transaction.
- Completion notifications deduplicate across SSE, Push, and delayed lifecycle events.
- History appends eight older turns at the bottom without replacing prior batches or moving the reading position; the same control lazily fetches server history and offers a bounded return to the latest turns.
- Exact-turn interrupt, new session creation, permanent deletion confirmation, target tracking, Markdown tables, safe links, and HTML escaping pass.
- Revoked device history stays bounded at 20 and can be purged without affecting active devices.

## Comparison history

1. Baseline: runtime controls were nested in the continuation region, the new-session action could be displaced on short screens, and revoked device rows occupied the main device list.
2. Fixes: independent runtime sheet, sticky new-session submit bar, active-first device sections, collapsed bounded archive, and lifecycle diagnostics.
3. Current: `artifacts/stabilization-v41/comparison.png`; no actionable P0/P1/P2 findings remain.

final result: passed
