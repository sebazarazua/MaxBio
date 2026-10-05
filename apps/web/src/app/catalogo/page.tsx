import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { Classifications } from '@/components/catalog/classifications';
export const metadata: Metadata = { title: 'Marcas y categorías' };
export default function Page() {
  return (
    <Workspace>
      <Classifications />
    </Workspace>
  );
}
