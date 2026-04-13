# Rebuild V2 Shared Protocol

This folder stores shared server/client schema definitions.

- `protocol.json` defines typed message contracts for the current websocket protocol.
- `render_state_v1` is the authoritative server render payload used by the client compositor.
- `renderPosition` inside `render_state_v1` is authoritative runtime-space data. Client screen placement must use `screen = wrap256(wheelPixel - hofs/vofs)` and must not mix in map-local-adjusted fallbacks.
