'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import {
  catalogInspectionSchema,
  catalogImportSchema,
  catalogImportRowsSchema,
  catalogImportListSchema,
  supplierCatalogItemSchema,
  supplierCatalogListSchema,
  supplierCatalogLimits,
  catalogMappingFields,
  apiErrorSchema,
  type CatalogInspection,
  type CatalogImportView,
  type SupplierCatalogItemView,
} from '@maxbio/contracts';
import { catalogFetch, CatalogHttpError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import {
  CatalogImportPreviewTable,
  formatCatalogPrice,
  catalogOutcomeLabels,
} from './catalog-import-preview-table';
import {
  EntityChoice,
  Feedback,
  Field,
  Pagination,
  SearchBar,
  useMutation,
  useResource,
  useSearch,
} from './common';

export function Unassociated() {
  return (
    <span
      className="status-tag"
      title="Todavía no se confirmó qué producto de MaxBio corresponde a este artículo."
    >
      Sin asociar
    </span>
  );
}
export function ReferenceAssociation({ item }: { item: SupplierCatalogItemView }) {
  if (!item.supplierProduct) return <Unassociated />;
  return (
    <div>
      <span className="status-tag">Asociado</span>
      <br />
      <Link href={'/productos/' + item.supplierProduct.product.id}>
        {item.supplierProduct.product.name} · Ver producto
      </Link>
      {(item.supplierProduct.archivedAt || item.supplierProduct.product.archivedAt) && (
        <small className="muted">Vínculo o producto archivado</small>
      )}
    </div>
  );
}
export function ReferenceCatalog({
  supplier,
}: {
  supplier?: { id: string; name: string; archivedAt: string | null };
}) {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const [revision, setRevision] = useState(0);
  const [importing, setImporting] = useState(false);
  const [supplierFilter, setSupplierFilter] = useState<{
    id: string;
    name: string;
    archivedAt: string | null;
  } | null>(null);
  const supplierId = supplierFilter?.id ?? '';

  const [sort, setSort] = useState('CODE');
  const [direction, setDirection] = useState('asc');
  const [association, setAssociation] = useState('ALL');
  const resource = useResource(
    (supplier ? `suppliers/${supplier.id}/catalog-items` : 'supplier-catalog-items') +
      '?' +
      search.query +
      '&association=' +
      association +
      '&sort=' +
      sort +
      '&direction=' +
      direction +
      (supplierId ? '&supplierId=' + supplierId : ''),
    supplierCatalogListSchema,
  );
  return (
    <section className="catalog-panel">
      <div className="page-heading">
        <div>
          <h2>{supplier ? 'Catálogo del proveedor' : 'Listas de proveedores'}</h2>
          <p className="muted">
            Lo que informa cada proveedor y su asociación confirmada con productos de MaxBio.
          </p>
        </div>
        {supplier && isAdmin && !supplier.archivedAt && (
          <button className="primary-button" onClick={() => setImporting(!importing)}>
            {importing ? 'Cerrar importación' : 'Importar lista'}
          </button>
        )}
      </div>
      {importing && supplier && (
        <CatalogImport
          supplier={supplier}
          done={() => {
            resource.reload();
            setRevision((value) => value + 1);
          }}
        />
      )}
      <SearchBar
        state={search}
        placeholder="Código, descripción, marca, presentación, GTIN o proveedor"
      />
      {!supplier && (
        <EntityChoice
          kind="suppliers"
          label="Proveedor"
          value={supplierFilter}
          change={(value) => {
            setSupplierFilter(value);
            search.setPage(1);
          }}
          allowCreate={false}
          emptyLabel="Todos"
        />
      )}
      <Field label="Ordenar por">
        <select
          value={sort}
          onChange={(event) => {
            setSort(event.target.value);
            search.setPage(1);
          }}
        >
          <option value="CODE">Código</option>
          <option value="SUPPLIER">Proveedor</option>
          <option value="DESCRIPTION">Nombre</option>
          <option value="PRICE">Precio</option>
        </select>
      </Field>
      <Field label="Orden">
        <select
          value={direction}
          onChange={(event) => {
            setDirection(event.target.value);
            search.setPage(1);
          }}
        >
          <option value="asc">Ascendente</option>
          <option value="desc">Descendente</option>
        </select>
      </Field>
      <Field label="Asociación">
        <select
          value={association}
          onChange={(event) => {
            setAssociation(event.target.value);
            search.setPage(1);
          }}
        >
          <option value="ALL">Todos</option>
          <option value="UNASSOCIATED">Sin asociar</option>
          <option value="ASSOCIATED">Asociados</option>
        </select>
      </Field>
      <Feedback {...resource} reload={resource.reload} />
      {resource.data && (
        <>
          <div className="reference-table-scroll">
            <table className="reference-table">
              <caption className="sr-only">Referencias comerciales de proveedores</caption>
              <thead>
                <tr>
                  <th scope="col">Proveedor / código</th>
                  <th scope="col">Descripción</th>
                  <th scope="col">Marca / presentación</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={'/proveedores/' + item.supplierId}>{item.supplier.name}</Link>
                      <br />
                      <Link className="code" href={'/referencias/' + item.id}>
                        {item.internalReferenceCode}
                      </Link>
                      <small>Código del proveedor: {item.supplierCode ?? '—'}</small>
                    </td>
                    <td>
                      <Link href={'/referencias/' + item.id}>{item.description ?? '—'}</Link>
                      {item.reportedGtin && (
                        <small className="muted">
                          GTIN informado: {item.reportedGtin}
                          {!item.normalizedReportedGtin && ' (revisar)'}
                        </small>
                      )}
                    </td>
                    <td>
                      {item.brandText || '—'}
                      <small className="muted">{item.presentationText || '—'}</small>
                    </td>
                    <td>
                      {item.price !== null && (
                        <small>{formatCatalogPrice(item.price, item.currency)}</small>
                      )}
                      <ReferenceAssociation item={item} />
                      {item.missingFromLatestCompleteListAt && (
                        <small className="muted">No aparece en la última lista completa</small>
                      )}
                      {(item.archivedAt || item.supplier.archivedAt) && (
                        <small className="muted">Archivado</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!resource.data.items.length && (
            <p className="empty-copy">No hay referencias para esta búsqueda.</p>
          )}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
      {supplier && <ImportHistory key={revision} supplierId={supplier.id} />}
    </section>
  );
}
export function ReferenceDetail({ id }: { id: string }) {
  const resource = useResource('supplier-catalog-items/' + id, supplierCatalogItemSchema);
  if (!resource.data) return <Feedback {...resource} reload={resource.reload} />;
  const item = resource.data;
  return (
    <>
      <Link className="back-link" href={'/proveedores/' + item.supplierId}>
        ← {item.supplier.name}
      </Link>
      <p className="eyebrow">REFERENCIA DEL PROVEEDOR</p>
      <h1>{item.description ?? item.internalReferenceCode}</h1>
      <ReferenceAssociation item={item} />
      <p className="catalog-notice">
        {item.supplierProduct
          ? 'Esta referencia conserva su producto confirmado. Podés agregarle un identificador desde Identificar producto.'
          : 'Todavía no se confirmó qué producto de MaxBio corresponde a este artículo.'}{' '}
        <Link href="/identificar">Identificar producto</Link>
      </p>
      <section className="catalog-panel">
        <dl className="data-grid">
          {[
            ['Código MaxBio', item.internalReferenceCode],
            ['Proveedor', item.supplier.name],
            ['Código del proveedor', item.supplierCode],
            ['Código alternativo', item.alternateSupplierCode],
            [
              'Precio declarado',
              item.price === null ? null : formatCatalogPrice(item.price, item.currency),
            ],
            ['IVA declarado (%)', item.vatRate],
            [
              'Precio incluye IVA',
              item.priceIncludesVat === 'YES'
                ? 'Sí'
                : item.priceIncludesVat === 'NO'
                  ? 'No'
                  : 'Desconocido',
            ],
            ['Marca declarada', item.brandText],
            ['Fabricante', item.manufacturerText],
            ['Modelo', item.modelText],
            ['Categoría', item.categoryText],
            ['Unidad', item.unitText],
            ['Presentación declarada', item.presentationText],
            ['GTIN informado', item.reportedGtin],
            ['GTIN normalizado', item.normalizedReportedGtin],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
        {item.reportedGtin && !item.normalizedReportedGtin && (
          <p className="catalog-notice">
            El GTIN informado es inválido. Conservamos el texto como declaración del proveedor.
          </p>
        )}
        {item.missingFromLatestCompleteListAt && (
          <p className="catalog-notice">
            No aparece en la última lista completa del proveedor. Su historia se conserva.
          </p>
        )}
        {(item.archivedAt || item.supplier.archivedAt) && (
          <p className="catalog-notice">Esta referencia o su proveedor está archivado.</p>
        )}
      </section>
    </>
  );
}
async function uploadFile(supplierId: string, file: File) {
  const form = new FormData();
  form.set('file', file);
  const response = await fetch('/api/supplier-catalog-upload/' + supplierId, {
    method: 'POST',
    headers: { 'X-Maxbio-Csrf': '1' },
    body: form,
    signal: AbortSignal.timeout(40000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      window.dispatchEvent(new Event('maxbio-session-check'));
    const error = apiErrorSchema.safeParse(data);
    throw new CatalogHttpError(
      response.status,
      error.success ? error.data.message : 'No pudimos leer el archivo. Volvé a intentar.',
    );
  }
  return catalogInspectionSchema.parse(data);
}
export function CatalogImport({
  supplier,
  done,
}: {
  supplier: { id: string; name: string };
  done: () => void;
}) {
  const mutation = useMutation();
  const [inspection, setInspection] = useState<CatalogInspection | null>(null);
  const [preview, setPreview] = useState<CatalogImportView | null>(null);
  const [result, setResult] = useState<CatalogImportView | null>(null);
  const [exclude, setExclude] = useState(false);
  const [mode, setMode] = useState<'PARTIAL' | 'COMPLETE'>('PARTIAL');
  const [currency, setCurrency] = useState('ARS');
  const [localError, setLocalError] = useState('');
  async function review(uploadId: string, options = false) {
    const reviewed = await mutation.run(() =>
      catalogFetch(`suppliers/${supplier.id}/catalog-imports/preview`, catalogImportSchema, {
        method: 'POST',
        body: { uploadId, mode, ...(options ? { currency } : {}) },
      }),
    );
    if (reviewed) {
      setPreview(reviewed);
      setCurrency(reviewed.commercial.defaultCurrency ?? 'ARS');
      setExclude(false);
    }
  }
  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError('');
    const file = new FormData(event.currentTarget).get('file');
    if (!(file instanceof File) || !file.size || file.size > supplierCatalogLimits.fileBytes) {
      setLocalError('Elegí un archivo de hasta 10 MiB.');
      return;
    }
    const inspected = await mutation.run(() => uploadFile(supplier.id, file));
    if (!inspected) return;
    setInspection(inspected);
    setResult(null);
    await review(inspected.uploadId);
  }
  async function confirm() {
    if (!preview) return;
    const committed = await mutation.run(() =>
      catalogFetch(`supplier-catalog-imports/${preview.id}/commit`, catalogImportSchema, {
        method: 'POST',
        body: { previewHash: preview.previewHash, excludeInvalidRows: exclude },
      }),
    );
    if (committed) {
      setResult(committed);
      done();
    }
  }
  return (
    <div className="catalog-panel">
      <h3>Importar lista de {supplier.name}</h3>
      {(mutation.error || localError) && (
        <p className="catalog-error" role="alert">
          {localError || mutation.error}
        </p>
      )}
      {result ? (
        <>
          <p role="status">Importación confirmada.</p>
          <ImportSummary value={result} />
          <ImportRows key={result.id + 'committed'} id={result.id} />
          <button
            className="secondary-button"
            onClick={() => {
              setResult(null);
              setPreview(null);
              setInspection(null);
              mutation.clear();
            }}
          >
            Importar otra lista
          </button>
        </>
      ) : !preview ? (
        <form onSubmit={(event) => void analyze(event)}>
          <fieldset disabled={mutation.busy}>
            <Field label="Archivo CSV o Excel">
              <input name="file" type="file" accept=".csv,.xlsx" required />
            </Field>
            <button className="primary-button">{mutation.busy ? 'Analizando…' : 'Analizar'}</button>
          </fieldset>
        </form>
      ) : (
        <>
          <p role="status">
            Encontramos{' '}
            {preview.summary.created + preview.summary.updated + preview.summary.unchanged}{' '}
            referencias.
          </p>
          <ImportSummary value={preview} />
          <ImportRows key={preview.id} id={preview.id} />
          {inspection && (
            <details>
              <summary>Opciones de lista</summary>
              <Field label="Moneda para precios sin moneda">
                <select
                  value={currency}
                  disabled={mutation.busy}
                  onChange={(event) => setCurrency(event.target.value)}
                >
                  <option value="ARS">ARS</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="BRL">BRL</option>
                  <option value="UYU">UYU</option>
                  {!['ARS', 'USD', 'EUR', 'BRL', 'UYU'].includes(currency) && (
                    <option value={currency}>{currency}</option>
                  )}
                </select>
              </Field>
              <Field label="Actualización">
                <select
                  value={mode}
                  disabled={mutation.busy}
                  onChange={(event) => setMode(event.target.value as 'PARTIAL' | 'COMPLETE')}
                >
                  <option value="PARTIAL">Actualizar los artículos incluidos</option>
                  <option value="COMPLETE">Lista completa</option>
                </select>
              </Field>
              <p className="muted">
                Una lista completa marca como ausentes las referencias que no aparecen; conserva su
                historia.
              </p>
              <button
                className="secondary-button"
                disabled={mutation.busy}
                onClick={() => void review(inspection.uploadId, true)}
              >
                Actualizar vista previa
              </button>
            </details>
          )}
          {inspection && (
            <details>
              <summary>Detalles de análisis</summary>
              <p>
                Hoja: {preview.sheetName} · Encabezado: fila {preview.headerRow}
              </p>
              <p>
                Campos reconocidos:{' '}
                {Object.entries(preview.mapping)
                  .filter(([, column]) => column !== null)
                  .map(
                    ([field]) => catalogMappingFields[field as keyof typeof catalogMappingFields],
                  )
                  .join(', ')}
              </p>
              <p>Interpretación de alta confianza; campos dudosos sin informar.</p>
              {inspection.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
              {inspection.sheets
                .find((sheet) => sheet.name === preview.sheetName)
                ?.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
            </details>
          )}
          {(preview.summary.errors > 0 || preview.summary.conflicts > 0) && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={exclude}
                disabled={mutation.busy}
                onChange={(event) => setExclude(event.target.checked)}
              />{' '}
              Confirmo que se excluyan las filas con errores y conflictos.
            </label>
          )}
          <p className="catalog-notice">
            Se guardarán referencias del proveedor. No se crean productos ni asociaciones ni
            existencias.
          </p>
          <div className="actions">
            <button
              className="secondary-button"
              disabled={mutation.busy}
              onClick={() => {
                setPreview(null);
                setInspection(null);
                mutation.clear();
              }}
            >
              Elegir otro archivo
            </button>
            <button
              className="primary-button"
              disabled={
                mutation.busy ||
                (!exclude && preview.summary.errors + preview.summary.conflicts > 0) ||
                preview.summary.created + preview.summary.updated + preview.summary.unchanged === 0
              }
              onClick={() => void confirm()}
            >
              {mutation.busy ? 'Importando…' : 'Confirmar importación'}
            </button>
          </div>
          {mutation.conflict && inspection && (
            <button
              className="secondary-button"
              disabled={mutation.busy}
              onClick={() => void review(inspection.uploadId, true)}
            >
              Analizar de nuevo
            </button>
          )}
        </>
      )}
    </div>
  );
}
function ImportSummary({ value }: { value: CatalogImportView }) {
  const summary = value.summary;
  return (
    <dl className="data-grid">
      {[
        ['Proveedor', value.supplier.name],
        ['Archivo', value.fileName],
        ['Moneda para precios sin moneda', value.commercial.defaultCurrency ?? 'ARS'],
        ['Nuevas referencias', summary.created],
        ['A actualizar', summary.updated],
        ['Sin cambios', summary.unchanged],
        ['Repetidas', summary.duplicates],
        ['Vacías / ignoradas', summary.empty],
        ['Errores', summary.errors],
        ['Conflictos', summary.conflicts],
        ['Advertencias', summary.warnings],
        ['Ausentes', summary.missing],
      ].map(([label, content]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{content}</dd>
        </div>
      ))}
      {summary.absencesSuppressed && (
        <p className="catalog-notice">
          No se marcarán ausencias porque la lista requiere revisión.
        </p>
      )}
    </dl>
  );
}
function ImportRows({ id }: { id: string }) {
  const [page, setPage] = useState(1);
  const [outcome, setOutcome] = useState('');
  const resource = useResource(
    `supplier-catalog-imports/${id}/rows?` +
      new URLSearchParams({ page: String(page), ...(outcome ? { outcome } : {}) }),
    catalogImportRowsSchema,
  );
  return (
    <section className="import-rows">
      <h3>Filas de la lista</h3>
      <Field label="Mostrar filas">
        <select
          value={outcome}
          onChange={(event) => {
            setOutcome(event.target.value);
            setPage(1);
          }}
        >
          <option value="">Todas</option>
          {Object.entries(catalogOutcomeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Feedback {...resource} reload={resource.reload} />
      {resource.data && (
        <>
          <CatalogImportPreviewTable rows={resource.data.items} />
          <Pagination {...resource.data} change={setPage} />
        </>
      )}
    </section>
  );
}
function ImportHistory({ supplierId }: { supplierId: string }) {
  const [page, setPage] = useState(1);
  const resource = useResource(
    `suppliers/${supplierId}/catalog-imports?page=${page}`,
    catalogImportListSchema,
  );
  return (
    <details>
      <summary>Historial de listas importadas</summary>
      <Feedback {...resource} reload={resource.reload} />
      {resource.data && (
        <>
          <ul className="association-list">
            {resource.data.items.map((item) => (
              <li key={item.id}>
                <Link href={'/referencias/importaciones/' + item.id}>{item.fileName}</Link>
                <span className="muted">
                  {new Date(item.committedAt!).toLocaleString('es-AR', {
                    timeZone: 'America/Buenos_Aires',
                  })}{' '}
                  · {item.actor.displayName}
                </span>
              </li>
            ))}
          </ul>
          {!resource.data.items.length && <p>No hay importaciones confirmadas.</p>}
          <Pagination {...resource.data} change={setPage} />
        </>
      )}
    </details>
  );
}
export function ImportResult({ id }: { id: string }) {
  const resource = useResource('supplier-catalog-imports/' + id, catalogImportSchema);
  if (!resource.data) return <Feedback {...resource} reload={resource.reload} />;
  return (
    <>
      <Link className="back-link" href={'/proveedores/' + resource.data.supplierId}>
        ← Proveedor
      </Link>
      <h1>Lista importada</h1>
      <p className="muted">
        {resource.data.status === 'COMMITTED' ? 'Confirmada' : 'Vista previa'} ·{' '}
        {resource.data.actor.displayName}
      </p>
      <section className="catalog-panel">
        <h2>Resultado de la lista</h2>
        <ImportSummary value={resource.data} />
        <ImportRows id={id} />
      </section>
    </>
  );
}
