# `rebuild/shared`

Shared protocol/schema definitions and shared constants.

## Modules

- `mapgrid.py`: map-grid and metatile decoding helpers.
- `protocol.py`: single-source WebSocket protocol message definitions and
  compact binary codec.
- `generate_protocol_bindings.py`: exports generated Rust/TypeScript wire
  bindings from `protocol.py`.

## Codegen

Regenerate protocol bindings after editing `protocol.py`:

```bash
python3 rebuild/shared/generate_protocol_bindings.py
```
