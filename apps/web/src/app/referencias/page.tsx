import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ReferenceCatalog } from '@/components/catalog/supplier-catalog';
export const metadata: Metadata = { title: 'Referencias de proveedores' };
export default function Page() {
  return (
    <Workspace>
      <p className="eyebrow">CATÁLOGO DE REFERENCIA</p>
      <h1>Referencias de proveedores</h1>
      <ReferenceCatalog />
    </Workspace>
  );
}
