import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { SupplierEditor } from '@/components/catalog/forms';
export const metadata: Metadata = { title: 'Editar proveedor' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <SupplierEditor id={id} />
    </Workspace>
  );
}
