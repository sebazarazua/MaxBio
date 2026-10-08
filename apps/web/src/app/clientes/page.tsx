import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { CustomersList } from '@/components/customers/list';
export const metadata: Metadata = { title: 'Clientes' };
export default function Page() {
  return (
    <Workspace>
      <CustomersList />
    </Workspace>
  );
}
