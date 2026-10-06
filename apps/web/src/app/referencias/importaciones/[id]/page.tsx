import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ImportResult } from '@/components/catalog/supplier-catalog';
export const metadata: Metadata = { title: 'Resultado de importación' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <ImportResult id={id} />
    </Workspace>
  );
}
