import type { DeliveryNoteView } from '@maxbio/contracts';

// Rendering needs values, never a persisted document or business identity.
type Line = DeliveryNoteView['lines'][number];
export type PrintDocument = Pick<
  DeliveryNoteView,
  | 'status'
  | 'version'
  | 'documentDate'
  | 'documentPrefix'
  | 'documentNumber'
  | 'patientName'
  | 'affiliateNumber'
  | 'notes'
> & {
  customer: Pick<
    DeliveryNoteView['customer'],
    | 'name'
    | 'legalName'
    | 'cuit'
    | 'taxConditionText'
    | 'addressLine'
    | 'locality'
    | 'province'
    | 'postalCode'
  >;
  lines: (Pick<Line, 'productName' | 'presentation' | 'quantity' | 'unitOfMeasure'> & {
    allocations: Pick<
      Line['allocations'][number],
      'quantity' | 'lotNumber' | 'expirationDate' | 'serialNumber'
    >[];
  })[];
};
