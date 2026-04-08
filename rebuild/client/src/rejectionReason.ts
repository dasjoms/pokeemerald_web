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
  }
}
