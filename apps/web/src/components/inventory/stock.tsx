'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import {
  inventoryStockListSchema,
  inventoryStockDetailSchema,
  inventoryHistorySchema,
  inventoryAdjustmentResultSchema,
  type InventoryAdjustment,
  type InventoryStockDetail,
} from '@maxbio/contracts';
import { inventoryFetch } from '@/lib/inventory-api';
import { CatalogHttpError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { Feedback, Field, Pagination, SearchBar, useSearch } from '../catalog/common';
import {
  useInventoryResource,
  useInventoryMutation,
  InventoryPolicyEditor,
  conditionLabels,
  quantityLabels,
} from './common';
const operationLabels = {
  OUTBOUND: 'Salida por remito',
  RECEIPT: 'Ingreso de proveedor',
  INITIAL_COUNT: 'Inventario inicial',
  ADJUSTMENT: 'Ajuste administrativo',
};
export function StockList() {
  const search = useSearch();
  const resource = useInventoryResource('stock?' + search.query, inventoryStockListSchema);
  return (
    <>
      <p className="eyebrow">INVENTARIO</p>
      <h1>Stock</h1>
      <p className="page-intro">Buscá por producto, código interno, GTIN, lote o serie.</p>
      <div className="actions">
        <Link href="/inventario/ingresos">Ingresar productos</Link>
        <Link href="/inventario/inicial">Inventario inicial</Link>
      </div>
      <section className="catalog-panel">
        <SearchBar state={search} placeholder="Producto, código, GTIN, lote o serie" />
        <Feedback loading={resource.loading} error={resource.error} reload={resource.reload} />
        {resource.data && (
          <>
            <p className="muted">
              Existencia registrada · fecha del depósito: {resource.data.businessDate}
            </p>
            <div className="reference-table-scroll">
              <table className="reference-table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Disponible</th>
                    <th>Físico</th>
                    <th>No disponible</th>
                    <th>Próximo vencimiento</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.items.map((i) => (
                    <tr key={i.product.id}>
                      <td>
                        <Link href={'/stock/' + i.product.id}>{i.product.name}</Link>
                        <p className="muted">
                          {quantityLabels[i.product.unitOfMeasure]}
                          {i.countInProgress
                            ? ' · En conteo'
                            : i.initializedAt
                              ? ' · Inventario inicial confirmado'
                              : ' · Sin inventario inicial'}
                        </p>
                      </td>
                      <td>{i.available}</td>
                      <td>{i.physical}</td>
                      <td>{i.unavailable}</td>
                      <td>{i.nextExpirationDate ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {resource.data.items.length === 0 && <p>No encontramos productos con esa búsqueda.</p>}
            <Pagination
              total={resource.data.total}
              page={search.page}
              limit={resource.data.limit}
              change={search.setPage}
            />
          </>
        )}
      </section>
    </>
  );
}

function PositionAdjustment({
  position,
  detail,
  onSaved,
}: {
  position: InventoryStockDetail['positions'][number];
  detail: InventoryStockDetail;
  onSaved: () => void;
}) {
  const mutation = useInventoryMutation();
  const [observed, setObserved] = useState(position.quantity),
    [reason, setReason] = useState<InventoryAdjustment['reason']>('COUNT'),
    [notes, setNotes] = useState(''),
    [pending, setPending] = useState(false);
  const attempt = useRef<InventoryAdjustment | null>(null);
  async function save() {
    if (!attempt.current) {
      attempt.current = {
        operationId: crypto.randomUUID(),
        positionId: position.id,
        expectedScopeVersion: detail.scopeVersion!,
        observedQuantity: observed.trim().replace(',', '.'),
        reason,
        notes: notes.trim(),
      };
      setPending(true);
    }
    const result = await mutation.run(
      () =>
        inventoryFetch('adjustments', inventoryAdjustmentResultSchema, {
          method: 'POST',
          body: attempt.current,
        }),
      (cause) => {
        if (cause instanceof CatalogHttpError && cause.status < 500) {
          attempt.current = null;
          setPending(false);
        }
      },
    );
    if (result) {
      attempt.current = null;
      setPending(false);
      onSaved();
    }
  }
  return (
    <section className="catalog-panel">
      <h3>Ajustar existencia</h3>
      <p>
        {position.lotNumber ? 'Lote ' + position.lotNumber : 'Sin lote'} ·{' '}
        {conditionLabels[position.condition]}
        {position.serialNumber ? ' · Serie ' + position.serialNumber : ''}
      </p>
      <p>
        Esperado: {position.quantity} {quantityLabels[detail.summary.product.unitOfMeasure]}. Se
        registrará la diferencia con el conteo observado.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={mutation.busy || pending}>
          <Field label="Cantidad física observada">
            <input
              inputMode="decimal"
              required
              value={observed}
              onChange={(e) => setObserved(e.target.value)}
            />
          </Field>
          <Field label="Motivo">
            <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
              <option value="COUNT">Conteo físico</option>
              <option value="ADMIN_ERROR">Error administrativo</option>
              <option value="LOSS">Pérdida</option>
              <option value="DAMAGE_DISPOSAL">Desecho por daño</option>
              <option value="OTHER">Otro</option>
            </select>
          </Field>
          <Field label="Explicación">
            <textarea
              required
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </fieldset>
        <button className="primary-button" disabled={mutation.busy}>
          {mutation.busy
            ? 'Confirmando…'
            : pending
              ? 'Reintentar el mismo ajuste'
              : 'Confirmar ajuste'}
        </button>
        <Feedback error={mutation.error} />
      </form>
    </section>
  );
}

export function StockDetail({ productId }: { productId: string }) {
  const { isAdmin } = useWorkspace();
  const [page, setPage] = useState(1),
    [historyPage, setHistoryPage] = useState(1),
    [selected, setSelected] = useState<string | null>(null);
  const detail = useInventoryResource(
    `products/${productId}?page=${page}`,
    inventoryStockDetailSchema,
  );
  const history = useInventoryResource(
    `products/${productId}/history?page=${historyPage}`,
    inventoryHistorySchema,
  );
  const d = detail.data;
  const position = d?.positions.find((p) => p.id === selected);
  function refresh() {
    setSelected(null);
    detail.reload();
    history.reload();
  }
  return (
    <>
      <Link href="/stock">Volver al stock</Link>
      <Feedback loading={detail.loading} error={detail.error} reload={detail.reload} />
      {d && (
        <>
          <p className="eyebrow">INVENTARIO</p>
          <h1>{d.summary.product.name}</h1>
          <p className="page-intro">
            Cantidad en {quantityLabels[d.summary.product.unitOfMeasure]} · Existencia registrada al{' '}
            {d.businessDate}
          </p>
          <section className="catalog-panel">
            <div className="inventory-summary">
              <p>
                <strong>Disponible</strong>
                <span>{d.summary.available}</span>
              </p>
              <p>
                <strong>Físico</strong>
                <span>{d.summary.physical}</span>
              </p>
              <p>
                <strong>No disponible</strong>
                <span>{d.summary.unavailable}</span>
              </p>
            </div>
            <p>
              {d.summary.initializedAt
                ? 'Inventario inicial confirmado el ' +
                  new Date(d.summary.initializedAt).toLocaleDateString('es-AR')
                : 'Este producto no tiene inventario inicial confirmado. Las cantidades muestran solamente movimientos registrados.'}
            </p>
            {d.summary.countInProgress && (
              <p role="status">
                Producto en conteo. Los ingresos quedan pendientes hasta que termine o se cancele
                esa sesión.
              </p>
            )}
            <p className="muted">
              Los productos vencidos, dañados y en cuarentena siguen físicamente presentes y no
              están disponibles.
            </p>
          </section>
          <section className="catalog-panel">
            <h2>Lotes y existencias físicas</h2>
            <div className="reference-table-scroll">
              <table className="reference-table">
                <thead>
                  <tr>
                    <th>Depósito</th>
                    <th>Lote / serie</th>
                    <th>Vencimiento</th>
                    <th>Condición</th>
                    <th>Cantidad</th>
                    {isAdmin && <th>Ajuste</th>}
                  </tr>
                </thead>
                <tbody>
                  {d.positions.map((p) => (
                    <tr key={p.id}>
                      <td>{p.location.name}</td>
                      <td>
                        {p.lotNumber ??
                          (p.expirationDate ? 'Grupo sin número de lote' : 'Sin lote')}
                        {p.serialNumber && <p className="code">Serie {p.serialNumber}</p>}
                      </td>
                      <td>
                        {p.expirationDate ?? 'No aplica'}
                        {p.expired ? (
                          <strong> · Vencido</strong>
                        ) : p.expiringSoon ? (
                          <strong> · Próximo a vencer</strong>
                        ) : null}
                      </td>
                      <td>{conditionLabels[p.condition]}</td>
                      <td>{p.quantity}</td>
                      {isAdmin && (
                        <td>
                          <button
                            className="secondary-button"
                            disabled={d.summary.countInProgress}
                            onClick={() => setSelected(p.id)}
                          >
                            Registrar diferencia
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.positions.length === 0 && <p>No hay existencia física registrada.</p>}
            <Pagination total={d.total} page={page} limit={d.limit} change={setPage} />
          </section>
          {position && (
            <PositionAdjustment
              key={position.id + ':' + d.scopeVersion}
              position={position}
              detail={d}
              onSaved={refresh}
            />
          )}
          {isAdmin && (
            <details>
              <summary>Configurar los datos físicos del producto</summary>
              <InventoryPolicyEditor
                key={productId + ':' + (d.policy?.version ?? 0)}
                productId={productId}
                policy={d.policy}
                onSaved={() => detail.reload()}
              />
            </details>
          )}
        </>
      )}
      <section className="catalog-panel">
        <h2>Historial</h2>
        <Feedback loading={history.loading} error={history.error} reload={history.reload} />
        {history.data && (
          <>
            <div className="reference-table-scroll">
              <table className="reference-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Operación</th>
                    <th>Cambio</th>
                    <th>Usuario</th>
                    <th>Origen / detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.items.map((h) => (
                    <tr key={h.id} id={'movimiento-' + h.id}>
                      <td>{new Date(h.recordedAt).toLocaleString('es-AR')}</td>
                      <td>{operationLabels[h.type]}</td>
                      <td>
                        {h.change === '0'
                          ? '0'
                          : h.change.startsWith('-')
                            ? h.change
                            : '+' + h.change}
                      </td>
                      <td>{h.actorName}</td>
                      <td>
                        {h.supplierName}
                        {h.sourceId && (
                          <p>
                            <Link
                              href={
                                h.type === 'OUTBOUND'
                                  ? '/remitos/' + h.sourceId
                                  : '/inventario/' +
                                    (h.type === 'RECEIPT' ? 'ingresos' : 'inicial') +
                                    '/' +
                                    h.sourceId
                              }
                            >
                              Ver operación
                            </Link>
                          </p>
                        )}
                        {h.notes && <p>{h.notes}</p>}
                        <details>
                          <summary>Ver datos físicos</summary>
                          {h.lines.map((l, i) => (
                            <p key={i}>
                              {l.quantityDelta} {quantityLabels[l.unitOfMeasure]} ·{' '}
                              {l.lotNumber ? 'Lote ' + l.lotNumber : 'Sin lote'} ·{' '}
                              {l.expirationDate ?? 'Sin vencimiento'} ·{' '}
                              {conditionLabels[l.condition]}
                              {l.serialNumber ? ' · Serie ' + l.serialNumber : ''}
                            </p>
                          ))}
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {history.data.items.length === 0 && <p>Todavía no hay operaciones de stock.</p>}
            <Pagination
              total={history.data.total}
              page={historyPage}
              limit={history.data.limit}
              change={setHistoryPage}
            />
          </>
        )}
      </section>
    </>
  );
}
