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
  catalogColumnMappingSchema,
  catalogMappingFields,
  supplierCatalogLimits,
  apiErrorSchema,
  type CatalogInspection,
  type CatalogImportView,
  type CatalogColumnMapping,
  type CatalogImportRowView,
} from '@maxbio/contracts';
import { catalogFetch, CatalogHttpError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import {
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
export function ReferenceCatalog({
  supplier,
}: {
  supplier?: { id: string; name: string; archivedAt: string | null };
}) {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const [revision, setRevision] = useState(0);
  const [importing, setImporting] = useState(false);
  const resource = useResource(
    (supplier ? `suppliers/${supplier.id}/catalog-items` : 'supplier-catalog-items') +
      '?' +
      search.query,
    supplierCatalogListSchema,
  );
  return (
    <section className="catalog-panel">
      <div className="page-heading">
        <div>
          <h2>{supplier ? 'Catálogo del proveedor' : 'Referencias de proveedores'}</h2>
          <p className="muted">
            Lo que informa cada proveedor. Todavía no se confirmó qué producto de MaxBio corresponde
            a cada artículo.
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
      <SearchBar state={search} placeholder="Código, descripción, marca, GTIN o proveedor" />
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
                        {item.supplierCode}
                      </Link>
                    </td>
                    <td>
                      <Link href={'/referencias/' + item.id}>{item.description}</Link>
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
                      <Unassociated />
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
      <h1>{item.description}</h1>
      <Unassociated />
      <p className="catalog-notice">
        Todavía no se confirmó qué producto de MaxBio corresponde a este artículo.
      </p>
      <section className="catalog-panel">
        <dl className="data-grid">
          {[
            ['Proveedor', item.supplier.name],
            ['Código del proveedor', item.supplierCode],
            ['Marca declarada', item.brandText],
            ['Presentación declarada', item.presentationText],
            ['GTIN informado', item.reportedGtin],
            ['GTIN normalizado', item.normalizedReportedGtin],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || 'Sin especificar'}</dd>
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
type MappingDraft = Record<keyof CatalogColumnMapping, number | null>;
export function CatalogImport({
  supplier,
  done,
}: {
  supplier: { id: string; name: string };
  done: () => void;
}) {
  const mutation = useMutation();
  const [inspection, setInspection] = useState<CatalogInspection | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState<MappingDraft>({
    supplierCode: null,
    description: null,
    brandText: null,
    presentationText: null,
    reportedGtin: null,
  });
  const [mode, setMode] = useState<'PARTIAL' | 'COMPLETE'>('PARTIAL');
  const [preview, setPreview] = useState<CatalogImportView | null>(null);
  const [result, setResult] = useState<CatalogImportView | null>(null);
  const [exclude, setExclude] = useState(false);
  const [localError, setLocalError] = useState('');
  const sheet = inspection?.sheets.find((sheet) => sheet.name === sheetName);
  const headers = sheet?.sample[headerRow - 1] ?? [];
  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError('');
    const file = new FormData(event.currentTarget).get('file');
    if (!(file instanceof File) || !file.size || file.size > supplierCatalogLimits.fileBytes) {
      setLocalError('Elegí un archivo de hasta 10 MiB.');
      return;
    }
    const inspected = await mutation.run(() => uploadFile(supplier.id, file));
    if (inspected) {
      setInspection(inspected);
      const first = inspected.sheets[0]!;
      setSheetName(first.name);
      setHeaderRow(first.headerRow);
      setMapping(first.suggestedMapping);
      setPreview(null);
      setResult(null);
    }
  }
  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError('');
    if (!inspection) return;
    if (mapping.supplierCode === null || mapping.description === null) {
      setLocalError(
        mapping.supplierCode === null
          ? 'Elegí qué columna contiene el código del proveedor.'
          : 'Elegí qué columna contiene la descripción.',
      );
      return;
    }
    const columns = catalogColumnMappingSchema.safeParse(mapping);
    if (!columns.success) {
      setLocalError('Elegí una columna diferente para cada campo.');
      return;
    }
    const reviewed = await mutation.run(() =>
      catalogFetch(`suppliers/${supplier.id}/catalog-imports/preview`, catalogImportSchema, {
        method: 'POST',
        body: {
          uploadId: inspection.uploadId,
          sheet: sheetName,
          headerRow,
          mapping: columns.data,
          mode,
        },
      }),
    );
    if (reviewed) {
      setPreview(reviewed);
      setExclude(false);
    }
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
      setInspection(null);
      setPreview(null);
      done();
    }
  }
  return (
    <div className="catalog-import">
      <p className="eyebrow">
        {result
          ? '5. RESULTADO'
          : preview
            ? '3. REVISAR · 4. CONFIRMAR'
            : inspection
              ? '2. COLUMNAS'
              : '1. ARCHIVO'}
      </p>
      <h3>Importar lista · {supplier.name}</h3>
      <p className="muted">
        CSV o XLSX · hasta 10 MiB, 10.000 artículos y 100 columnas. Los códigos se conservan como
        texto; en Excel, guardalos como Texto para conservar ceros iniciales.
      </p>
      <Feedback error={localError || mutation.error} />
      {result ? (
        <>
          <p role="status">Importación confirmada. El catálogo ya está disponible.</p>
          <ImportSummary value={result} />
          <Link className="secondary-button" href={'/referencias/importaciones/' + result.id}>
            Ver resultado y filas
          </Link>
          <button
            className="secondary-button"
            onClick={() => {
              setResult(null);
              mutation.clear();
            }}
          >
            Importar otra lista
          </button>
        </>
      ) : !inspection ? (
        <form onSubmit={(event) => void inspect(event)}>
          <fieldset disabled={mutation.busy}>
            <Field label="Archivo">
              <input name="file" type="file" accept=".csv,.xlsx" required />
            </Field>
            <button className="primary-button">
              {mutation.busy ? 'Leyendo archivo…' : 'Leer archivo'}
            </button>
          </fieldset>
        </form>
      ) : !preview ? (
        <form onSubmit={(event) => void review(event)}>
          <fieldset disabled={mutation.busy}>
            <p>
              <strong>Archivo:</strong> {inspection.fileName}
            </p>
            <div className="form-grid">
              <Field label="Hoja">
                <select
                  value={sheetName}
                  onChange={(event) => {
                    const selected = inspection.sheets.find(
                      (sheet) => sheet.name === event.target.value,
                    )!;
                    setSheetName(selected.name);
                    setHeaderRow(selected.headerRow);
                    setMapping(selected.suggestedMapping);
                  }}
                >
                  {inspection.sheets.map((sheet) => (
                    <option key={sheet.name}>{sheet.name}</option>
                  ))}
                </select>
              </Field>
              <Field
                label="Fila de encabezados"
                help="Si la lista tiene un título arriba, elegí la fila con los nombres de las columnas."
              >
                <input
                  type="number"
                  min={1}
                  max={Math.min(20, sheet?.sample.length || 1)}
                  value={headerRow}
                  onChange={(event) => setHeaderRow(Number(event.target.value))}
                />
              </Field>
            </div>
            <div className="form-grid">
              {Object.entries(catalogMappingFields).map(([key, label]) => (
                <Field
                  key={key}
                  label={`¿Qué columna contiene ${key === 'description' || key === 'brandText' || key === 'presentationText' ? 'la' : 'el'} ${label}?`}
                  help={
                    key === 'supplierCode' || key === 'description'
                      ? 'Obligatorio'
                      : 'Opcional. Si no la elegís, conservamos el dato anterior.'
                  }
                >
                  <select
                    value={mapping[key as keyof MappingDraft] ?? ''}
                    onChange={(event) =>
                      setMapping((current) => ({
                        ...current,
                        [key]: event.target.value === '' ? null : Number(event.target.value),
                      }))
                    }
                    required={key === 'supplierCode' || key === 'description'}
                  >
                    <option value="">Elegí una columna</option>
                    {Array.from({ length: sheet?.headers.length ?? 0 }, (_, index) => (
                      <option key={index} value={index}>
                        {index + 1}. {headers[index] || `Columna ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <Field label="Cómo usar esta lista">
              <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                <option value="PARTIAL">Actualizar artículos incluidos</option>
                <option value="COMPLETE">Esta es la lista completa</option>
              </select>
            </Field>
            <p className="muted">
              {mode === 'COMPLETE'
                ? 'Las referencias que no aparezcan se indicarán como ausentes. No se eliminan. Si hay errores, no se marcarán ausencias.'
                : 'Las referencias que no aparezcan conservan su información.'}
            </p>
            <details>
              <summary>Ver primeras filas del archivo</summary>
              <div className="reference-table-scroll">
                <table className="reference-table">
                  <caption>Primeras filas de {sheetName}</caption>
                  <tbody>
                    {sheet?.sample.slice(0, 8).map((row, index) => (
                      <tr key={index}>
                        <th scope="row">{index + 1}</th>
                        {row.map((cell, column) => (
                          <td key={column}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <div className="actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setInspection(null);
                  mutation.clear();
                }}
              >
                Elegir otro archivo
              </button>
              <button className="primary-button">
                {mutation.busy ? 'Validando…' : 'Revisar lista'}
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        <>
          <ImportSummary value={preview} />
          <ImportRows id={preview.id} />
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
            Al confirmar, se guardarán referencias del proveedor. No se crean productos de MaxBio ni
            asociaciones.
          </p>
          <div className="actions">
            <button
              className="secondary-button"
              disabled={mutation.busy}
              onClick={() => {
                setPreview(null);
                mutation.clear();
              }}
            >
              Volver a columnas
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
          {mutation.conflict && (
            <p className="catalog-notice">
              Volvé a columnas y revisá la lista otra vez para generar una vista previa actualizada.
            </p>
          )}
        </>
      )}
    </div>
  );
}
function ImportSummary({ value }: { value: CatalogImportView }) {
  const summary = value.summary;
  return (
    <>
      <dl className="data-grid">
        {[
          ['Proveedor', value.supplier.name],
          ['Archivo', value.fileName],
          ['Hoja', value.sheetName],
          ['Modalidad', value.mode === 'COMPLETE' ? 'Lista completa' : 'Actualizar incluidos'],
          ['Filas', summary.total],
          ['Nuevas referencias', summary.created],
          ['A actualizar', summary.updated],
          ['Sin cambios', summary.unchanged],
          ['Repetidas idénticas', summary.duplicates],
          ['Vacías / ignoradas', summary.empty],
          ['Errores', summary.errors],
          ['Conflictos', summary.conflicts],
          ['Advertencias GTIN', summary.warnings],
          ['Ausentes de lista completa', summary.missing],
        ].map(([label, content]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{content}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Columnas elegidas</summary>
        <ul>
          {Object.entries(value.mapping).map(([field, column]) => (
            <li key={field}>
              {catalogMappingFields[field as keyof CatalogColumnMapping]}:{' '}
              {column === null ? 'No elegida' : `columna ${column + 1}`}
            </li>
          ))}
        </ul>
      </details>
      {summary.absencesSuppressed && (
        <p className="catalog-notice">
          No se marcarán ausencias: esta lista completa tiene errores, conflictos o no contiene
          referencias válidas.
        </p>
      )}
    </>
  );
}
const outcomeLabels: Record<CatalogImportRowView['outcome'], string> = {
  CREATED: 'Nueva referencia',
  UPDATED: 'Actualización',
  UNCHANGED: 'Sin cambios',
  DUPLICATE: 'Repetida / ignorada',
  EMPTY: 'Vacía / ignorada',
  ERROR: 'Error / excluida',
  CONFLICT: 'Conflicto / excluida',
};
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
          {Object.entries(outcomeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Feedback {...resource} reload={resource.reload} />
      {resource.data && (
        <>
          <div className="reference-table-scroll">
            <table className="reference-table">
              <thead>
                <tr>
                  <th scope="col">Fila</th>
                  <th scope="col">Código / descripción</th>
                  <th scope="col">Datos informados</th>
                  <th scope="col">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.rowNumber}</td>
                    <td>
                      <strong className="code">{row.supplierCode || '—'}</strong>
                      <p>{row.data?.description}</p>
                    </td>
                    <td>
                      {row.data?.brandText || '—'}
                      <small>{row.data?.presentationText}</small>
                      <small>{row.data?.reportedGtin && `GTIN: ${row.data.reportedGtin}`}</small>
                    </td>
                    <td>
                      {outcomeLabels[row.outcome]}
                      {row.messages.map((message, index) => (
                        <small key={index}>{message}</small>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
