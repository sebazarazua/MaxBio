import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ProductIdentification } from '@/components/catalog/identification';
export const metadata: Metadata = { title: 'Identificar producto' };
export default function Page() {
  return (
    <Workspace>
      <p className="eyebrow">IDENTIFICACIÓN FÍSICA</p>
      <h1>Identificar producto</h1>
      <ProductIdentification />
    </Workspace>
  );
}
