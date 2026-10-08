import { Workspace } from '@/components/workspace';
import { DeliveryNoteDetail } from '@/components/delivery-notes/editor';
export const metadata = { title: 'Remitos' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Workspace>
      <DeliveryNoteDetail id={id} />
    </Workspace>
  );
}
