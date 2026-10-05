import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { SuppliersList } from '@/components/catalog/lists';
export const metadata: Metadata = { title: 'Proveedores' };
export default function Page() {
  return (
    <Workspace>
      <SuppliersList />
    </Workspace>
  );
}
