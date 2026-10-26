// Stable machine codes. Human text lives outside the parser; contracts mirror this list.
export const GS1_REASON_CODES = [
  'EMPTY_SCAN',
  'SCAN_TOO_LONG',
  'TOO_MANY_ELEMENTS',
  'TOO_MANY_ISSUES',
  'INVALID_CHARACTER',
  'INVALID_CONTROL',
  'MALFORMED_AI',
  'MIXED_FORMAT',
  'FORMAT_CONFLICT',
  'UNSUPPORTED_SYMBOLOGY',
  'UNSUPPORTED_FORMAT',
  'MISSING_GTIN',
  'INVALID_GTIN',
  'INVALID_EXPIRATION',
  'EXPIRATION_DAY_UNSPECIFIED',
  'INVALID_FIELD_LENGTH',
  'DUPLICATE_AI',
  'UNSUPPORTED_AI',
  'TRUNCATED_ELEMENT',
  'MISSING_SEPARATOR',
  'UNEXPECTED_SEPARATOR',
] as const;
export type Gs1ReasonCode = (typeof GS1_REASON_CODES)[number];

export const MAX_SCAN_LENGTH = 512;
export const MAX_GS1_ELEMENTS = 32;
export const MAX_GS1_ISSUES = 16;

export type Gs1Symbology = 'GS1_DATAMATRIX' | 'GS1_128' | 'GS1_QR';
export type Gs1AimPrefix = ']d2' | ']C1' | ']Q3';
export type Gs1Issue = {
  code: Gs1ReasonCode;
  severity: 'ERROR' | 'REVIEW';
  ai?: string;
  offset?: number;
};
export type Gs1Fields = {
  gtin14?: string;
  lotNumber?: string;
  expirationDate?: string;
  expiration?: { encoded: string; precision: 'DAY' | 'MONTH' };
  serialNumber?: string;
};
// Offsets refer to the normalized payload: zero based, end exclusive. Ephemeral diagnostics only.
export type Gs1Element = { ai: string; value: string; start: number; end: number };

export type Gs1ParseResult =
  | { kind: 'NOT_GS1' }
  | { kind: 'REJECTED'; status: 'INVALID' | 'UNSUPPORTED'; reasonCode: Gs1ReasonCode }
  | {
      kind: 'GS1';
      status: 'VALID' | 'PARTIAL' | 'INVALID';
      syntax: 'ELEMENT_STRING' | 'HRI';
      symbology: Gs1Symbology | null;
      aimPrefix: Gs1AimPrefix | null;
      complete: boolean;
      referenceYear: number;
      fields: Gs1Fields;
      elements: Gs1Element[];
      issues: Gs1Issue[];
      canResolveIdentity: boolean;
      canApplyPhysicalData: boolean;
    };
export type Gs1Parsed = Extract<Gs1ParseResult, { kind: 'GS1' }>;
export type Gs1ParseOptions = { referenceYear: number };
