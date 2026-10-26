import { hasValidGtinCheckDigit } from './gtin.js';
import {
  MAX_GS1_ELEMENTS,
  MAX_GS1_ISSUES,
  MAX_SCAN_LENGTH,
  type Gs1AimPrefix,
  type Gs1Element,
  type Gs1Fields,
  type Gs1Issue,
  type Gs1ParseOptions,
  type Gs1ParseResult,
  type Gs1Parsed,
  type Gs1ReasonCode,
  type Gs1Symbology,
} from './gs1-types.js';

// Pure, bounded GS1 interpreter for AIs 01/10/17/21 (AI 11 only as structural framing).
// Never reads the clock, never resynchronises after an unknown raw AI and never invents separators.
const GS = '\x1d';
const SUPPORTED_AIM: Record<string, Gs1Symbology> = {
  ']d2': 'GS1_DATAMATRIX',
  ']C1': 'GS1_128',
  ']Q3': 'GS1_QR',
};
const GENERIC_AIM = new Set([']C0', ']d1', ']Q1']);
const BUSINESS_AIS = new Set(['01', '10', '17', '21']);
const DESCRIPTORS: Record<string, { fixed?: number; max?: number }> = {
  '01': { fixed: 14 },
  '10': { max: 20 },
  '11': { fixed: 6 },
  '17': { fixed: 6 },
  '21': { max: 20 },
};
const isDigits = (value: string) => value.length > 0 && /^[0-9]+$/.test(value);
// GS1 General Specifications 26.0, table 7-20 (character set 82).
function inCharacterSet82(code: number) {
  return (
    code === 33 ||
    code === 34 ||
    (code >= 37 && code <= 63) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}
// "(NN)" with two to four digits; bounded lookahead keeps HRI tokenisation linear.
function hriMarkerAt(text: string, index: number) {
  if (text[index] !== '(') return null;
  let end = index + 1;
  while (
    end < text.length &&
    end - index <= 5 &&
    text.charCodeAt(end) >= 48 &&
    text.charCodeAt(end) <= 57
  )
    end++;
  const digits = end - index - 1;
  return digits >= 2 && digits <= 4 && text[end] === ')'
    ? { ai: text.slice(index + 1, end), end: end + 1 }
    : null;
}
const hasEmbeddedHri = (text: string) => /\((?:01|10|17|21)\)/.test(text);
function isBareCandidate(text: string) {
  if (/^[0-9]+$/.test(text) && [8, 12, 13, 14].includes(text.length)) return false;
  return (
    (text.startsWith('01') && text.length >= 16) ||
    (text.length >= 24 && /^17[0-9]{6}01/.test(text))
  );
}
const hasGs1Evidence = (text: string) =>
  text.includes(GS) ||
  Boolean(hriMarkerAt(text, 0)) ||
  hasEmbeddedHri(text) ||
  isBareCandidate(text);
function isDigitalLink(text: string) {
  if (!/^https?:\/\//i.test(text)) return false;
  const rest = text.slice(text.indexOf('//') + 2);
  return /^id\.gs1\.org(?:[/?#]|$)/i.test(rest) || /\/(?:01|gtin)\/[0-9]/i.test(rest);
}
// Spaces before the first framing character and one final terminator are transport, not data.
function frame(raw: string) {
  let start = 0;
  while (start < raw.length && raw[start] === ' ') start++;
  let end = raw.length;
  if (raw.endsWith('\r\n')) end -= 2;
  else if (/[\r\n\t]$/.test(raw)) end -= 1;
  return raw.slice(start, Math.max(start, end));
}
function transportIssue(payload: string, allowGs: boolean): Gs1ReasonCode | null {
  for (let index = 0; index < payload.length; index++) {
    const code = payload.charCodeAt(index);
    if (code === 0x1d && allowGs) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return 'INVALID_CONTROL';
    if (code > 0x7e) return 'INVALID_CHARACTER';
  }
  return null;
}
function daysInMonth(year: number, month: number) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
// §7.12: the unique year with these two digits inside [Y-49, Y+50].
export function expirationFromYymmdd(value: string, referenceYear: number) {
  if (value.length !== 6 || !isDigits(value)) return null;
  const yy = Number(value.slice(0, 2)),
    month = Number(value.slice(2, 4)),
    day = Number(value.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const first = referenceYear - 49;
  const year = first + ((yy - (first % 100) + 100) % 100);
  const last = daysInMonth(year, month);
  if (day > last) return null;
  const iso = (d: number) =>
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return day === 0
    ? { date: iso(last), precision: 'MONTH' as const }
    : { date: iso(day), precision: 'DAY' as const };
}

class Collector {
  readonly fields: Gs1Fields = {};
  readonly elements: Gs1Element[] = [];
  readonly issues: Gs1Issue[] = [];
  private readonly occurrences = new Map<string, number>();
  complete = true;
  constructor(
    private readonly syntax: 'ELEMENT_STRING' | 'HRI',
    private readonly symbology: Gs1Symbology | null,
    private readonly aimPrefix: Gs1AimPrefix | null,
    private readonly referenceYear: number,
  ) {}
  get full() {
    return this.elements.length >= MAX_GS1_ELEMENTS;
  }
  get overflow() {
    return this.issues.at(-1)?.code === 'TOO_MANY_ISSUES';
  }
  issue(code: Gs1ReasonCode, severity: 'ERROR' | 'REVIEW', ai?: string, offset?: number) {
    if (this.overflow) return;
    if (this.issues.length >= MAX_GS1_ISSUES - 1) {
      this.issues.push({ code: 'TOO_MANY_ISSUES', severity: 'ERROR' });
      this.complete = false;
      return;
    }
    this.issues.push({
      code,
      severity,
      ...(ai === undefined ? {} : { ai }),
      ...(offset === undefined ? {} : { offset }),
    });
  }
  // Structural failure: nothing after this point is interpreted.
  stop(code: Gs1ReasonCode, offset: number, ai?: string) {
    this.issue(code, 'ERROR', ai, offset);
    this.complete = false;
  }
  add(ai: string, value: string, start: number, end: number) {
    this.elements.push({ ai, value, start, end });
    const seen = this.occurrences.get(ai) ?? 0;
    this.occurrences.set(ai, seen + 1);
    if (seen > 0 && BUSINESS_AIS.has(ai)) {
      if (seen === 1) this.issue('DUPLICATE_AI', 'ERROR', ai, start);
      // Never first-wins or last-wins: a repeated AI leaves its business field empty.
      if (ai === '01') delete this.fields.gtin14;
      if (ai === '10') delete this.fields.lotNumber;
      if (ai === '17') {
        delete this.fields.expirationDate;
        delete this.fields.expiration;
      }
      if (ai === '21') delete this.fields.serialNumber;
      return;
    }
    if (ai === '01') {
      if (value.length === 14 && isDigits(value) && hasValidGtinCheckDigit(value))
        this.fields.gtin14 = value;
      else this.issue('INVALID_GTIN', 'ERROR', ai, start);
    } else if (ai === '17') {
      const parsed = expirationFromYymmdd(value, this.referenceYear);
      if (!parsed) this.issue('INVALID_EXPIRATION', 'ERROR', ai, start);
      else {
        this.fields.expirationDate = parsed.date;
        this.fields.expiration = { encoded: value, precision: parsed.precision };
        if (parsed.precision === 'MONTH')
          this.issue('EXPIRATION_DAY_UNSPECIFIED', 'REVIEW', ai, start);
      }
    } else if (ai === '11') {
      if (value.length === 6 && isDigits(value)) this.issue('UNSUPPORTED_AI', 'REVIEW', ai, start);
      else this.issue('INVALID_FIELD_LENGTH', 'ERROR', ai, start);
    } else if (ai === '10' || ai === '21') {
      if (value.length < 1 || value.length > 20)
        this.issue('INVALID_FIELD_LENGTH', 'ERROR', ai, start);
      else {
        const bad = Array.from(value).findIndex((c) => !inCharacterSet82(c.charCodeAt(0)));
        if (bad >= 0) this.issue('INVALID_CHARACTER', 'ERROR', ai, start + bad);
        else if (ai === '10') this.fields.lotNumber = value;
        else this.fields.serialNumber = value;
      }
    } else this.issue('UNSUPPORTED_AI', 'REVIEW', ai, start);
  }
  result(): Gs1Parsed {
    const gtinCount = this.occurrences.get('01') ?? 0;
    if (this.complete && gtinCount === 0) this.issue('MISSING_GTIN', 'ERROR');
    const canResolveIdentity =
      this.complete && !this.overflow && gtinCount === 1 && this.fields.gtin14 !== undefined;
    const status = !canResolveIdentity ? 'INVALID' : this.issues.length ? 'PARTIAL' : 'VALID';
    return {
      kind: 'GS1',
      status,
      syntax: this.syntax,
      symbology: this.symbology,
      aimPrefix: this.aimPrefix,
      complete: this.complete,
      referenceYear: this.referenceYear,
      fields: this.fields,
      elements: this.elements,
      issues: this.issues,
      canResolveIdentity,
      canApplyPhysicalData: status === 'VALID',
    };
  }
}

function elementString(
  payload: string,
  symbology: Gs1Symbology | null,
  aimPrefix: Gs1AimPrefix | null,
  referenceYear: number,
): Gs1ParseResult {
  const transport = transportIssue(payload, true);
  if (transport) return { kind: 'REJECTED', status: 'INVALID', reasonCode: transport };
  const c = new Collector('ELEMENT_STRING', symbology, aimPrefix, referenceYear);
  if (!payload.length) c.stop('TRUNCATED_ELEMENT', 0);
  let index = 0;
  // Every iteration consumes at least one character or stops.
  while (index < payload.length && c.complete) {
    if (payload[index] === GS) {
      c.stop('UNEXPECTED_SEPARATOR', index);
      break;
    }
    if (c.full) {
      c.stop('TOO_MANY_ELEMENTS', index);
      break;
    }
    const ai = payload.slice(index, index + 2);
    if (ai.length < 2 || !isDigits(ai)) {
      c.stop(ai.length < 2 && isDigits(ai) ? 'TRUNCATED_ELEMENT' : 'MALFORMED_AI', index);
      break;
    }
    const descriptor = DESCRIPTORS[ai];
    if (!descriptor) {
      // Unknown raw length: stop here instead of hunting for the next plausible AI.
      c.stop('UNSUPPORTED_AI', index, ai);
      break;
    }
    const start = index + 2;
    let end: number;
    if (descriptor.fixed) {
      end = start + descriptor.fixed;
      if (end > payload.length || payload.slice(start, end).includes(GS)) {
        c.stop('TRUNCATED_ELEMENT', start, ai);
        break;
      }
    } else {
      const separator = payload.indexOf(GS, start);
      end = separator === -1 ? payload.length : separator;
      if (end === start && end === payload.length) {
        c.stop('TRUNCATED_ELEMENT', start, ai);
        break;
      }
      // A variable field longer than its maximum proves a lost separator; never split it.
      if (end - start > descriptor.max!) {
        c.stop('MISSING_SEPARATOR', start, ai);
        break;
      }
    }
    c.add(ai, payload.slice(start, end), start, end);
    if (c.overflow) break;
    index = end;
    if (payload[index] === GS) {
      index++;
      if (index === payload.length || payload[index] === GS) {
        c.stop('UNEXPECTED_SEPARATOR', index - 1);
        break;
      }
    }
  }
  return c.result();
}

function humanReadable(text: string, referenceYear: number): Gs1ParseResult {
  const transport = transportIssue(text, false);
  if (transport) return { kind: 'REJECTED', status: 'INVALID', reasonCode: transport };
  const c = new Collector('HRI', null, null, referenceYear);
  let index = 0;
  while (index < text.length && c.complete) {
    const marker = hriMarkerAt(text, index);
    if (!marker) {
      c.stop('MALFORMED_AI', index);
      break;
    }
    if (c.full) {
      c.stop('TOO_MANY_ELEMENTS', index);
      break;
    }
    let end = marker.end;
    while (end < text.length && !hriMarkerAt(text, end)) end++;
    c.add(marker.ai, text.slice(marker.end, end), marker.end, end);
    if (c.overflow) break;
    index = end;
  }
  return c.result();
}

export function parseGs1(raw: string, options: Gs1ParseOptions): Gs1ParseResult {
  const { referenceYear } = options;
  if (!Number.isInteger(referenceYear) || referenceYear < 1000 || referenceYear > 9000)
    throw new RangeError('referenceYear must be an explicit business year.');
  if (typeof raw !== 'string')
    return { kind: 'REJECTED', status: 'INVALID', reasonCode: 'INVALID_CHARACTER' };
  if (!raw.length) return { kind: 'REJECTED', status: 'INVALID', reasonCode: 'EMPTY_SCAN' };
  if (raw.length > MAX_SCAN_LENGTH)
    return { kind: 'REJECTED', status: 'INVALID', reasonCode: 'SCAN_TOO_LONG' };
  const text = frame(raw);
  if (text.startsWith(']')) {
    const prefix = text.slice(0, 3);
    const payload = text.slice(3);
    const symbology = SUPPORTED_AIM[prefix];
    if (symbology) {
      if (payload.startsWith(']') || payload.startsWith('('))
        return { kind: 'REJECTED', status: 'INVALID', reasonCode: 'MIXED_FORMAT' };
      return elementString(payload, symbology, prefix as Gs1AimPrefix, referenceYear);
    }
    // Generic or unknown carriers keep their legacy identity unless they try to carry GS1 data.
    if (hasGs1Evidence(payload))
      return {
        kind: 'REJECTED',
        status: 'UNSUPPORTED',
        reasonCode: GENERIC_AIM.has(prefix) ? 'FORMAT_CONFLICT' : 'UNSUPPORTED_SYMBOLOGY',
      };
    return { kind: 'NOT_GS1' };
  }
  if (isDigitalLink(text))
    return { kind: 'REJECTED', status: 'UNSUPPORTED', reasonCode: 'UNSUPPORTED_FORMAT' };
  if (hriMarkerAt(text, 0)) {
    if (text.includes(GS))
      return { kind: 'REJECTED', status: 'INVALID', reasonCode: 'MIXED_FORMAT' };
    return humanReadable(text, referenceYear);
  }
  if (text.includes(GS) || isBareCandidate(text))
    return elementString(text, null, null, referenceYear);
  // Markers embedded in other text were already reserved; they never become external codes.
  if (hasEmbeddedHri(text))
    return { kind: 'REJECTED', status: 'INVALID', reasonCode: 'MIXED_FORMAT' };
  return { kind: 'NOT_GS1' };
}
