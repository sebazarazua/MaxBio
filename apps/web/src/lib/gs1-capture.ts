import { scanReasonMessages, type ScanInterpretation } from '@maxbio/contracts';

// Pure mapping from the backend GS1 interpretation to the Receipt/Count capture form.
// The scanner proposes; the operator reviews and presses Agregar. Nothing here persists.
type Policy = { lotRequired: boolean; expirationRequired: boolean; serialRequired: boolean };
export type ReviewKey = 'lot' | 'expiration' | 'serial' | 'data';
export type ReviewItem = {
  key: ReviewKey;
  message: string;
  // Discarding is offered only when the policy does not require the datum.
  canDiscard: boolean;
};
export type CapturePlan = {
  lot: string;
  expiration: string;
  serial: string | null;
  review: ReviewItem[];
  notes: string[];
};

export const displayDate = (iso: string) => iso.split('-').reverse().join('/');
export function issueMessages(scan: ScanInterpretation, ai?: string) {
  return [
    ...new Set(
      scan.issues
        .filter((issue) => ai === undefined || issue.ai === ai)
        .map((issue) => scanReasonMessages[issue.code]),
    ),
  ];
}
export function physicalSummary(scan: ScanInterpretation | undefined) {
  if (!scan) return [];
  const f = scan.fields;
  return [
    f.lotNumber ? 'Lote: ' + f.lotNumber : null,
    f.expirationDate
      ? f.expiration?.precision === 'MONTH'
        ? 'Vence: ' + displayDate(f.expirationDate).slice(3) + ' (sin día; revisá la etiqueta)'
        : 'Vence: ' + displayDate(f.expirationDate)
      : null,
    f.serialNumber ? 'Serie: ' + f.serialNumber : null,
  ].filter((line): line is string => line !== null);
}

export function capturePlan(scan: ScanInterpretation | undefined, policy: Policy): CapturePlan {
  const plan: CapturePlan = { lot: '', expiration: '', serial: null, review: [], notes: [] };
  if (!scan) return plan;
  const f = scan.fields;
  const problems = (ai: string) => issueMessages(scan, ai).join(' ');
  if (f.lotNumber) plan.lot = f.lotNumber;
  else if (problems('10'))
    plan.review.push({ key: 'lot', message: problems('10'), canDiscard: !policy.lotRequired });
  else if (policy.lotRequired)
    plan.notes.push('Este producto requiere lote. Ingresalo desde la etiqueta.');
  if (f.expirationDate && f.expiration?.precision === 'MONTH')
    // Day 00 is never applied as an exact operational date (healthcare review).
    plan.review.push({
      key: 'expiration',
      message:
        'El código indica solo mes y año de vencimiento (' +
        displayDate(f.expirationDate).slice(3) +
        '). Ingresá la fecha exacta desde la etiqueta.',
      canDiscard: !policy.expirationRequired,
    });
  else if (f.expirationDate) plan.expiration = f.expirationDate;
  else if (problems('17'))
    plan.review.push({
      key: 'expiration',
      message: problems('17'),
      canDiscard: !policy.expirationRequired,
    });
  else if (policy.expirationRequired)
    plan.notes.push('Este producto requiere vencimiento. Ingresalo desde la etiqueta.');
  if (f.serialNumber) {
    if (policy.serialRequired) plan.serial = f.serialNumber;
    else
      plan.review.push({
        key: 'serial',
        message:
          'El código trae la serie ' +
          f.serialNumber +
          ', pero este producto no se maneja por serie. Un administrador puede revisar su política; si no, descartá la serie para este ingreso.',
        canDiscard: true,
      });
  } else if (problems('21'))
    plan.review.push({
      key: 'serial',
      message: problems('21'),
      canDiscard: !policy.serialRequired,
    });
  else if (policy.serialRequired)
    plan.notes.push('Este producto requiere una serie por unidad. Ingresala desde la etiqueta.');
  const other = scan.issues.filter((issue) => !['01', '10', '17', '21'].includes(issue.ai ?? ''));
  if (other.length)
    plan.review.push({
      key: 'data',
      message: [...new Set(other.map((issue) => scanReasonMessages[issue.code]))].join(' '),
      canDiscard: true,
    });
  return plan;
}

// One reading per paste: a single final terminator is transport, interior line breaks are not.
export function pastedReadingProblem(text: string) {
  return /[\r\n]/.test(text.replace(/(?:\r\n|\r|\n)$/, ''))
    ? 'Pegá una sola lectura por vez: el texto pegado tiene varias líneas.'
    : null;
}
export const serialList = (text: string) =>
  text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
// Exact, case-sensitive comparison; the backend remains the definitive defence.
export function serialInOperation(
  serial: string,
  capture: string,
  lines: Array<{ id: string; product: { id: string }; serialNumbers: string[] }>,
  productId: string,
  editingId: string | null,
) {
  return (
    serialList(capture).includes(serial) ||
    lines.some(
      (line) =>
        line.id !== editingId &&
        line.product.id === productId &&
        line.serialNumbers.includes(serial),
    )
  );
}
// A field absent from the new reading does not contradict the group; a different value does.
export function sameCaptureGroup(
  current: { productId: string; lot: string; expiration: string },
  next: { productId: string; plan: CapturePlan },
) {
  return (
    current.productId === next.productId &&
    next.plan.review.length === 0 &&
    (!next.plan.lot || next.plan.lot === current.lot.trim()) &&
    (!next.plan.expiration || next.plan.expiration === current.expiration)
  );
}
