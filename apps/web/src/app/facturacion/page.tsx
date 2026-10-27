import { Workspace } from '@/components/workspace';
import { Billing } from '@/components/invoicing/routes';
export const metadata = { title: 'Facturación' };
export default function Page() {
  return (
    <Workspace>
      <Billing />
    </Workspace>
  );
}
