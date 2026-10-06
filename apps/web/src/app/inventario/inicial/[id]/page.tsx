import { Workspace } from '@/components/workspace';
import { InventoryOperation } from '@/components/inventory/operations';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <InventoryOperation key={id} kind="counts" id={id} />
    </Workspace>
  );
}
