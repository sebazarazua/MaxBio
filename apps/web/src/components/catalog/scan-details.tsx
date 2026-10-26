import type { ScanInterpretation } from '@maxbio/contracts';
import { issueMessages, physicalSummary } from '@/lib/gs1-capture';

// Operator view of a GS1 reading: business data only, never AIs, AIM, offsets or YYMMDD.
export function ScanDetails({ scan }: { scan?: ScanInterpretation }) {
  if (!scan) return null;
  const lines = physicalSummary(scan);
  const issues = issueMessages(scan);
  return (
    <>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {issues.length > 0 && (
        <div className="catalog-notice">
          <p>
            <strong>Revisá estos datos de la etiqueta:</strong>
          </p>
          {issues.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
    </>
  );
}
