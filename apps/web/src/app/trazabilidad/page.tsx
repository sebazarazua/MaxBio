import { Workspace } from '@/components/workspace';
import { TraceabilitySearch } from '@/components/traceability/traceability';
import { traceabilityParams } from '@/lib/traceability';
export const metadata = { title: 'Trazabilidad' };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initial = traceabilityParams(await searchParams);
  return (
    <Workspace>
      {/* A new navigation (sidebar, Product or Remito link) starts from its own URL filters. */}
      <TraceabilitySearch key={JSON.stringify(initial)} initial={initial} />
    </Workspace>
  );
}
