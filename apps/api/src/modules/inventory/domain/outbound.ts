// Single source of the position-level rules that allow an OUTBOUND allocation.
// Used by Delivery Note posting (authority) and by physical matching (proposal only).
export type OutboundBlock =
  'LOCATION_ARCHIVED' | 'DAMAGED' | 'QUARANTINED' | 'EXPIRED' | 'POLICY_MISMATCH';
export function positionOutboundBlock(
  policy: { lotRequired: boolean; expirationRequired: boolean; serialRequired: boolean },
  position: {
    locationArchived: boolean;
    condition: 'USABLE' | 'DAMAGED' | 'QUARANTINE';
    lotNumber: string | null;
    expirationDate: string | null;
    hasSerial: boolean;
  },
  businessDay: string,
): OutboundBlock | null {
  if (position.locationArchived) return 'LOCATION_ARCHIVED';
  if (position.condition === 'DAMAGED') return 'DAMAGED';
  if (position.condition === 'QUARANTINE') return 'QUARANTINED';
  if (position.expirationDate && position.expirationDate < businessDay) return 'EXPIRED';
  if (
    (policy.lotRequired && !position.lotNumber) ||
    (policy.expirationRequired && !position.expirationDate) ||
    policy.serialRequired !== position.hasSerial
  )
    return 'POLICY_MISMATCH';
  return null;
}
