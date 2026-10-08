import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { CustomerEditor } from '@/components/customers/form';
export const metadata: Metadata = { title: 'Editar cliente' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <CustomerEditor id={id} />
    </Workspace>
  );
}
