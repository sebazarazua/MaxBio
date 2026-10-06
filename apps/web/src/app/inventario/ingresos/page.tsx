import { Workspace } from '@/components/workspace';
import { InventoryDocuments } from '@/components/inventory/operations';
export default function Page() {
  return (
    <Workspace>
      <InventoryDocuments kind="receipts" />
    </Workspace>
  );
}
