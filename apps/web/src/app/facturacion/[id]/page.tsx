import { Workspace } from '@/components/workspace';
import { InvoiceDetail } from '@/components/invoicing/routes';
export const metadata = { title: 'Factura' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <InvoiceDetail id={id} />
    </Workspace>
  );
}
