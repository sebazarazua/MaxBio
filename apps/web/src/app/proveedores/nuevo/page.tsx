import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { SupplierEditor } from '@/components/catalog/forms';
export const metadata: Metadata = { title: 'Nuevo proveedor' };
export default function Page() {
  return (
    <Workspace>
      <SupplierEditor />
    </Workspace>
  );
}
