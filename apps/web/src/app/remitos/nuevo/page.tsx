import { Workspace } from '@/components/workspace';
import { DeliveryNoteDetail } from '@/components/delivery-notes/editor';
export const metadata = { title: 'Remitos' };
export default function Page() {
  return (
    <Workspace>
      <DeliveryNoteDetail />
    </Workspace>
  );
}
