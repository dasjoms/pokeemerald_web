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
  });
});
