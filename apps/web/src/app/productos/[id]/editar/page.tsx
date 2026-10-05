import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ProductEditor } from '@/components/catalog/forms';
export const metadata: Metadata = { title: 'Editar producto' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <ProductEditor id={id} />
    </Workspace>
  );
}
