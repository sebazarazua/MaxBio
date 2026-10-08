import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { CustomerEditor } from '@/components/customers/form';
export const metadata: Metadata = { title: 'Nuevo cliente' };
export default function Page() {
  return (
    <Workspace>
      <CustomerEditor />
    </Workspace>
  );
}
