import { RejectionReason } from './protocol_generated';

export function rejectionReasonLabel(reason: RejectionReason): string {
  switch (reason) {
    case RejectionReason.NONE:
      return 'NONE';
    case RejectionReason.COLLISION:
      return 'COLLISION';
    case RejectionReason.OUT_OF_BOUNDS:
      return 'OUT_OF_BOUNDS';
    case RejectionReason.SEQUENCE_MISMATCH:
      return 'SEQUENCE_MISMATCH';
    case RejectionReason.NOT_JOINED:
      return 'NOT_JOINED';
    case RejectionReason.INVALID_DIRECTION:
      return 'INVALID_DIRECTION';
    case RejectionReason.FORCED_MOVEMENT_DISABLED:
      return 'FORCED_MOVEMENT_DISABLED';
    case RejectionReason.BIKE_INVALID_STATE_TRANSITION:
      return 'BIKE_INVALID_STATE_TRANSITION';
    case RejectionReason.BIKE_TURN_TOO_SHARP:
      return 'BIKE_TURN_TOO_SHARP';
    case RejectionReason.BIKE_WHEELIE_WINDOW_EXPIRED:
      return 'BIKE_WHEELIE_WINDOW_EXPIRED';
    case RejectionReason.BIKE_TILE_REQUIRES_MACH:
      return 'BIKE_TILE_REQUIRES_MACH';
  }
}
