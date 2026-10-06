import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ReferenceDetail } from '@/components/catalog/supplier-catalog';
export const metadata: Metadata = { title: 'Referencia de proveedor' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <ReferenceDetail id={id} />
    </Workspace>
  );
}
