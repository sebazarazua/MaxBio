import type { CatalogImportRowView } from '@maxbio/contracts';

export function formatCatalogPrice(
  price: string | null | undefined,
  currency: string | null | undefined,
): string {
  if (price === null || price === undefined) return '—';
  const [whole, cents = '00'] = price.split('.');
  const amount = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + cents.padEnd(2, '0');
  return (currency === 'ARS' ? '$' : (currency ?? '')) + ' ' + amount;
}
export const catalogOutcomeLabels: Record<CatalogImportRowView['outcome'], string> = {
  CREATED: 'Nueva referencia',
  UPDATED: 'Actualización',
  UNCHANGED: 'Sin cambios',
  DUPLICATE: 'Repetida / ignorada',
  EMPTY: 'Vacía / ignorada',
  ERROR: 'Error / excluida',
  CONFLICT: 'Conflicto / excluida',
};

export function CatalogImportPreviewTable({ rows }: { rows: CatalogImportRowView[] }) {
  return (
    <div className="reference-table-scroll">
      <table className="reference-table">
        <caption className="sr-only">Filas normalizadas de la lista</caption>
        <thead>
          <tr>
            {[
              'Fila',
              'Código MaxBio',
              'Código del proveedor',
              'Descripción',
              'Marca',
              'Precio',
              'IVA (%)',
              'Resultado',
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.rowNumber}</td>
              <td className="code">
                {row.data?.internalReferenceCode ??
                  (row.outcome === 'CREATED' || row.outcome === 'DUPLICATE'
                    ? 'Nueva referencia'
                    : '—')}
              </td>
              <td>{row.supplierCode ?? '—'}</td>
              <td>{row.data?.description ?? '—'}</td>
              <td>{row.data?.brandText ?? '—'}</td>
              <td>{formatCatalogPrice(row.data?.price, row.data?.currency)}</td>
              <td>{row.data?.vatRate ?? '—'}</td>
              <td>
                <strong>{catalogOutcomeLabels[row.outcome]}</strong>
                {row.messages.map((message, index) => (
                  <small key={index}>{message}</small>
                ))}
                <details
                  className="import-row-details"
                  open={row.outcome === 'ERROR' || row.outcome === 'CONFLICT'}
                >
                  <summary>
                    Ver detalles<span className="sr-only"> de la fila {row.rowNumber}</span>
                  </summary>
                  <dl className="data-grid">
                    {[
                      ['Código alternativo del proveedor', row.data?.alternateSupplierCode],
                      ['Fabricante', row.data?.manufacturerText],
                      ['Modelo', row.data?.modelText],
                      ['Categoría', row.data?.categoryText],
                      ['Presentación', row.data?.presentationText],
                      ['Unidad', row.data?.unitText],
                      ['GTIN informado', row.data?.reportedGtin],
                      ['GTIN normalizado', row.data?.normalizedReportedGtin],
                      ['Moneda', row.data?.currency],
                      [
                        'Incluye IVA',
                        row.data?.priceIncludesVat === 'YES'
                          ? 'Sí'
                          : row.data?.priceIncludesVat === 'NO'
                            ? 'No'
                            : null,
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value ?? '—'}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
