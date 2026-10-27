import { Workspace } from '@/components/workspace';
import { FiscalSettings } from '@/components/fiscal/settings';
export const metadata = { title: 'Configuración fiscal' };
export default function Page() {
  return (
    <Workspace>
      <FiscalSettings />
    </Workspace>
  );
}
