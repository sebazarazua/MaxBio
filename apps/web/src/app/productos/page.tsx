import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ProductsList } from '@/components/catalog/lists';
export const metadata: Metadata = { title: 'Productos' };
export default function Page() {
  return (
    <Workspace>
      <ProductsList />
    </Workspace>
  );
}
