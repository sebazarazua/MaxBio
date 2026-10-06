import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace';
import { ProductIdentification } from '@/components/catalog/identification';
import Link from 'next/link';
export const metadata: Metadata = { title: 'Identificar producto' };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const requested = (await searchParams).returnTo;
  const returnTo =
    typeof requested === 'string' &&
    /^\/inventario\/(ingresos|inicial)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requested,
    )
      ? requested
      : null;
  return (
    <Workspace>
      <p className="eyebrow">IDENTIFICACIÓN FÍSICA</p>
      <h1>Identificar producto</h1>
      {returnTo && (
        <p>
          <Link href={returnTo}>Volver a la operación de inventario guardada</Link>
        </p>
      )}
      <ProductIdentification />
    </Workspace>
  );
}
