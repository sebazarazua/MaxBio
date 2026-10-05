import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { SupplierDetail } from '@/components/catalog/details';
export const metadata: Metadata = { title: 'Proveedor' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <SupplierDetail id={id} />
    </Workspace>
  );
}
