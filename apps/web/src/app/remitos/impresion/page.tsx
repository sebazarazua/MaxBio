import { Workspace } from '@/components/workspace';
import { PrintTemplateManager } from '@/components/printing/template-manager';
export const metadata = { title: 'Impresión de remitos' };
export default function Page() {
  return (
    <Workspace>
      <PrintTemplateManager />
    </Workspace>
  );
}
