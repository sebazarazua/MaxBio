import { Workspace } from '@/components/workspace';
import { DeliveryNotesList } from '@/components/delivery-notes/list';
export const metadata = { title: 'Remitos' };
export default function Page() {
  return (
    <Workspace>
      <DeliveryNotesList />
    </Workspace>
  );
}
