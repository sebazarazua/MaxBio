import type { PrintEvaluation, PrintTemplate } from '@maxbio/contracts';
import { printIssueMessage } from './print-labels.ts';
export function PrintIssueSummary({
  issues,
  template,
}: {
  issues: PrintEvaluation['issues'];
  template: PrintTemplate;
}) {
  const blocked = [
    ...new Set(
      issues.filter((i) => i.state === 'BLOCKED').map((i) => printIssueMessage(i, template)),
    ),
  ];
  const warnings = [
    ...new Set(
      issues.filter((i) => i.state === 'WARNING').map((i) => printIssueMessage(i, template)),
    ),
  ];
  return (
    <>
      {blocked.length > 0 && (
        <div role="alert" className="print-status print-status-blocked">
          <strong>Hay datos que necesitan corregirse antes de confirmar o imprimir.</strong>
          <ul>
            {blocked.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <details className="print-warning-details">
          <summary>
            Hay {warnings.length}{' '}
            {warnings.length === 1
              ? 'dato para revisar visualmente'
              : 'datos para revisar visualmente'}
            . Ver detalles
          </summary>
          <ul>
            {warnings.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
