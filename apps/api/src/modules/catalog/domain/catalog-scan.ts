import {
  scanReasonMessages,
  type ScanInput,
  type ScanIdentity,
  type ScanInterpretation,
  type ScanReasonCode,
} from '@maxbio/contracts';
import { parseGs1 } from '../../../common/domain/scanning/gs1.js';
import type { Gs1Parsed } from '../../../common/domain/scanning/gs1-types.js';
import { normalizeIdentifier, CatalogRuleError } from './identifiers.js';

export type ScanRejection = {
  status: 'INVALID' | 'UNSUPPORTED';
  message: string;
  reasonCode?: ScanReasonCode;
  scan?: ScanInterpretation;
};
export type ScanClassification = { identity: ScanIdentity; scan?: ScanInterpretation };

// Transport view of the parser result: no raw scan, offsets, elements or unknown AI values.
function interpretation(parsed: Gs1Parsed): ScanInterpretation {
  return {
    format: 'GS1',
    status: parsed.status,
    syntax: parsed.syntax,
    symbology: parsed.symbology,
    referenceYear: parsed.referenceYear,
    fields: parsed.fields,
    issues: parsed.issues.map(({ code, severity, ai }) => ({
      code,
      severity,
      ...(ai && /^[0-9]{2,4}$/.test(ai) ? { ai } : {}),
    })),
    canApplyPhysicalData: parsed.canApplyPhysicalData,
  };
}

// GS1 intent is decided first; a failed GS1 reading never degrades to an internal/external code.
export function classifyScan(
  input: ScanInput,
  options: { referenceYear: number },
): ScanClassification | ScanRejection {
  const parsed = parseGs1(input.value, options);
  if (parsed.kind === 'REJECTED')
    return {
      status: parsed.status,
      reasonCode: parsed.reasonCode,
      message: scanReasonMessages[parsed.reasonCode],
    };
  if (parsed.kind === 'GS1') {
    if (input.namespace === 'INTERNAL_CODE')
      return {
        status: 'UNSUPPORTED',
        reasonCode: 'FORMAT_CONFLICT',
        message:
          'Esta lectura es un código GS1. Elegí el tipo de lectura "Scanner" para reconocerla; no se guarda como código interno.',
      };
    const scan = interpretation(parsed);
    if (!parsed.canResolveIdentity) {
      const blocking =
        parsed.issues.find((issue) => issue.severity === 'ERROR') ?? parsed.issues[0];
      const reasonCode = blocking?.code ?? 'MALFORMED_AI';
      return {
        status: reasonCode === 'UNSUPPORTED_AI' ? 'UNSUPPORTED' : 'INVALID',
        reasonCode,
        message: scanReasonMessages[reasonCode],
        scan,
      };
    }
    const gtin = parsed.fields.gtin14!;
    return {
      identity: { kind: 'GTIN', value: gtin, normalizedValue: gtin, supplierId: null },
      scan,
    };
  }
  return legacyScan(input);
}

// AUTO never turns a failed GTIN checksum into a supplier barcode.
function legacyScan(input: ScanInput): ScanClassification | ScanRejection {
  const value = input.value.trim();
  try {
    if (input.namespace === 'INTERNAL_CODE') {
      return {
        identity: { ...normalizeIdentifier({ kind: 'INTERNAL_CODE', value }), supplierId: null },
      };
    }
    if (/^[0-9]+$/.test(value) && [8, 12, 13, 14].includes(value.length))
      return { identity: { ...normalizeIdentifier({ kind: 'GTIN', value }), supplierId: null } };
    if (value.startsWith('MB-'))
      return {
        identity: {
          ...normalizeIdentifier({ kind: 'INTERNAL_BARCODE', value }),
          supplierId: null,
        },
      };
    const normalized = normalizeIdentifier({ kind: 'INTERNAL_CODE', value });
    return {
      identity: {
        kind: 'SUPPLIER_BARCODE',
        value: normalized.value,
        normalizedValue: normalized.normalizedValue,
        supplierId: input.supplierId ?? null,
      },
    };
  } catch (error) {
    if (error instanceof CatalogRuleError) return { status: 'INVALID', message: error.message };
    throw error;
  }
}
