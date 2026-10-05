import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ProductDetail } from '@/components/catalog/details';
export const metadata: Metadata = { title: 'Producto' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <ProductDetail id={id} />
    </Workspace>
  );
}
