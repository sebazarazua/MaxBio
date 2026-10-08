import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { CustomerDetail } from '@/components/customers/detail';
export const metadata: Metadata = { title: 'Cliente' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <CustomerDetail id={id} />
    </Workspace>
  );
}
