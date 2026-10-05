import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ProductEditor } from '@/components/catalog/forms';
export const metadata: Metadata = { title: 'Nuevo producto' };
export default function Page() {
  return (
    <Workspace>
      <ProductEditor />
    </Workspace>
  );
}
