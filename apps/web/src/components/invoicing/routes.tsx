'use client';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '../workspace.tsx';
import { BillingView } from './billing.tsx';
import { InvoiceDetailView } from './invoice-detail.tsx';

// Router/workspace bindings; the views take plain props so they mount in tests.
export function Billing() {
  const { isAdmin } = useWorkspace();
  const router = useRouter();
  return <BillingView isAdmin={isAdmin} open={(id) => router.push('/facturacion/' + id)} />;
}
export function InvoiceDetail({ id }: { id: string }) {
  const { isAdmin } = useWorkspace();
  const router = useRouter();
  return (
    <InvoiceDetailView id={id} isAdmin={isAdmin} discarded={() => router.replace('/facturacion')} />
  );
}
