import { describe, expect, it } from 'vitest';

import { RejectionReason } from './protocol_generated';
import { rejectionReasonLabel } from './rejectionReason';

describe('rejection reason conformance', () => {
  it('matches canonical enum values', () => {
    expect(RejectionReason.NONE).toBe(0);
    expect(RejectionReason.COLLISION).toBe(1);
    expect(RejectionReason.OUT_OF_BOUNDS).toBe(2);
    expect(RejectionReason.SEQUENCE_MISMATCH).toBe(3);
    expect(RejectionReason.NOT_JOINED).toBe(4);
    expect(RejectionReason.INVALID_DIRECTION).toBe(5);
    expect(RejectionReason.FORCED_MOVEMENT_DISABLED).toBe(6);
    expect(RejectionReason.BIKE_INVALID_STATE_TRANSITION).toBe(7);
    expect(RejectionReason.BIKE_TURN_TOO_SHARP).toBe(8);
    expect(RejectionReason.BIKE_WHEELIE_WINDOW_EXPIRED).toBe(9);
    expect(RejectionReason.BIKE_TILE_REQUIRES_MACH).toBe(10);
  });

  it('maps each enum value to a canonical label', () => {
    expect(rejectionReasonLabel(RejectionReason.NONE)).toBe('NONE');
    expect(rejectionReasonLabel(RejectionReason.COLLISION)).toBe('COLLISION');
    expect(rejectionReasonLabel(RejectionReason.OUT_OF_BOUNDS)).toBe('OUT_OF_BOUNDS');
    expect(rejectionReasonLabel(RejectionReason.SEQUENCE_MISMATCH)).toBe('SEQUENCE_MISMATCH');
    expect(rejectionReasonLabel(RejectionReason.NOT_JOINED)).toBe('NOT_JOINED');
    expect(rejectionReasonLabel(RejectionReason.INVALID_DIRECTION)).toBe('INVALID_DIRECTION');
    expect(rejectionReasonLabel(RejectionReason.FORCED_MOVEMENT_DISABLED)).toBe(
      'FORCED_MOVEMENT_DISABLED',
    );
    expect(rejectionReasonLabel(RejectionReason.BIKE_INVALID_STATE_TRANSITION)).toBe(
      'BIKE_INVALID_STATE_TRANSITION',
    );
    expect(rejectionReasonLabel(RejectionReason.BIKE_TURN_TOO_SHARP)).toBe(
      'BIKE_TURN_TOO_SHARP',
    );
    expect(rejectionReasonLabel(RejectionReason.BIKE_WHEELIE_WINDOW_EXPIRED)).toBe(
      'BIKE_WHEELIE_WINDOW_EXPIRED',
    );
    expect(rejectionReasonLabel(RejectionReason.BIKE_TILE_REQUIRES_MACH)).toBe(
      'BIKE_TILE_REQUIRES_MACH',
    );
  });
});
