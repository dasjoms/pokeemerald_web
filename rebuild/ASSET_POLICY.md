# Rebuild Asset Policy

## Dual-Source Strategy

The rebuild supports two asset source roots:

1. **Development source**: existing original asset folder structure in this repository.
2. **Rebuild source**: mirrored/similar asset structure under rebuild-owned paths.

## Build-Time Selection Only

Asset source selection is a **build-time** choice. Runtime remapping is out of scope for this phase.

## Mirrored Path Constraint

Current rebuild asset layout must mirror original structure (no custom path remapping yet). This keeps parity verification straightforward and minimizes translation risk.

## Parity Priority

Asset pipeline choices must preserve user-visible parity (map appearance, collision-relevant layout interpretation, and gameplay-relevant presentation behavior).
