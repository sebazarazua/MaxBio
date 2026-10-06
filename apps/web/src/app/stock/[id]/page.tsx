import { Workspace } from '@/components/workspace';
import { StockDetail } from '@/components/inventory/stock';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <StockDetail key={id} productId={id} />
    </Workspace>
  );
}
