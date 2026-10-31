'use client';
import Link from 'next/link';
import { useState } from 'react';
import {
  inventoryDocumentListSchema,
  invoiceListSchema,
  invoiceFiscalStatusLabels,
  invoicePendingListSchema,
  productListSchema,
  supplierCatalogListSchema,
} from '@maxbio/contracts';
import { useResource } from '../catalog/common.tsx';
import { ConnectionStatus } from '../connection-status.tsx';
import { Icon } from '../icon.tsx';
import { useWorkspace } from '../workspace.tsx';
import { formatMoney, internalReference } from '../../lib/invoicing.ts';

const shortcuts = [
  {
    href: '/inventario/ingresos',
    title: 'Ingresar productos',
    icon: 'products',
    description: 'Recibir mercadería y preparar su ingreso al stock.',
    action: 'Comenzar ingreso',
  },
  {
    href: '/identificar',
    title: 'Identificar productos',
    icon: 'scan',
    description: 'Escanear un código y asociarlo al producto correcto.',
    action: 'Identificar',
  },
  {
    href: '/remitos',
    title: 'Remitos',
    icon: 'document',
    description: 'Preparar entregas y consultar los remitos guardados.',
    action: 'Ver remitos',
  },
  {
    href: '/facturacion',
    title: 'Facturación',
    icon: 'billing',
    description: 'Facturar remitos y continuar comprobantes pendientes.',
    action: 'Ver facturación',
  },
] as const;
type Resource = { loading: boolean; error?: string; reload: () => void };
const number = (value: number) => value.toLocaleString('es-AR');
const dateTime = (value: string) =>
  new Date(value).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function ResourceError({ resource, subject }: { resource: Resource; subject: string }) {
  if (!resource.error) return null;
  return (
    <div className="dashboard-resource-error" role="alert">
      <p>
        No pudimos actualizar {subject}. {resource.error}
      </p>
      <button type="button" disabled={resource.loading} onClick={resource.reload}>
        Reintentar
      </button>
    </div>
  );
}
function Metric({
  label,
  href,
  value,
  resource,
}: {
  label: string;
  href: string;
  value?: number;
  resource: Resource;
}) {
  return (
    <div className="dashboard-metric">
      <dt>
        <Link href={href}>{label}</Link>
      </dt>
      <dd>
        {value === undefined ? (
          resource.loading ? (
            <span
              className="dashboard-skeleton"
              role="status"
              aria-label={`Cargando ${label.toLowerCase()}`}
            />
          ) : (
            '—'
          )
        ) : (
          number(value)
        )}
      </dd>
      {resource.error && value !== undefined && <small>Último dato disponible</small>}
      <ResourceError resource={resource} subject={label.toLowerCase()} />
    </div>
  );
}
function TaskCount({ total }: { total?: number }) {
  return total === undefined ? null : (
    <span className="dashboard-task-count" data-empty={total === 0}>
      {number(total)} {total === 1 ? 'pendiente' : 'pendientes'}
    </span>
  );
}
export function HomeDashboard({ isAdmin }: { isAdmin: boolean }) {
  // Workspace mounts children only after authentication; the date is not frozen at build time.
  const [openedAt] = useState(() => new Date());
  // Stable existing queries run independently, once on opening or on explicit refresh.
  // Their responses supply both summary and lists, without scanning all pages.
  const products = useResource('products?limit=1', productListSchema);
  const references = useResource(
    'supplier-catalog-items?association=UNASSOCIATED&limit=1',
    supplierCatalogListSchema,
  );
  const pending = useResource(
    'pending-delivery-notes?limit=3',
    invoicePendingListSchema,
    'invoices',
  );
  const drafts = useResource('?status=DRAFT&limit=3', invoiceListSchema, 'invoices');
  const readyInvoices = useResource('?status=READY&limit=5', invoiceListSchema, 'invoices');
  const receipts = useResource('receipts?limit=5', inventoryDocumentListSchema, 'inventory');
  const resources = [products, references, pending, drafts, readyInvoices, receipts];
  const loading = resources.some((r) => r.loading);
  const fiscalPending =
    readyInvoices.data?.items.filter((i) => i.fiscalStatus && i.fiscalStatus !== 'AUTHORIZED') ??
    [];
  const resumable = receipts.data?.items.filter((r) => r.status === 'DRAFT' && r.canEdit) ?? [];
  return (
    <div className="dashboard">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">Inicio</p>
          <h1>Centro de operaciones</h1>
          <p className="page-intro">
            Tus próximos pasos y el estado de la operación, en un solo lugar.
          </p>
        </div>
        <time className="dashboard-date" dateTime={openedAt.toISOString()}>
          {openedAt.toLocaleDateString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </time>
      </header>
      <nav className="home-cards dashboard-shortcuts" aria-label="Operaciones principales">
        {shortcuts.map((s) => (
          <Link key={s.href} href={s.href} className="home-card">
            <span className="dashboard-shortcut-icon">
              <Icon name={s.icon} size={24} />
              <span aria-hidden="true">↗</span>
            </span>
            <h2>{s.title}</h2>
            <p>{s.description}</p>
            <strong>
              {s.action} <span aria-hidden="true">→</span>
            </strong>
          </Link>
        ))}
      </nav>
      <section
        className="catalog-panel dashboard-summary"
        aria-labelledby="dashboard-summary-title"
      >
        <div className="dashboard-section-heading">
          <div>
            <h2 id="dashboard-summary-title">Resumen operativo</h2>
            <p>Datos de la organización activa. Se actualizan al abrir este panel.</p>
          </div>
          <button
            className="secondary-button dashboard-refresh"
            type="button"
            disabled={loading}
            aria-busy={loading}
            onClick={() => resources.forEach((r) => r.reload())}
          >
            {loading ? 'Actualizando…' : 'Actualizar resumen'}
          </button>
        </div>
        <dl className="dashboard-metrics">
          <Metric
            label="Productos activos"
            href="/productos"
            value={products.data?.total}
            resource={products}
          />
          <Metric
            label="Referencias sin asociar"
            href="/referencias"
            value={references.data?.total}
            resource={references}
          />
          <Metric
            label="Remitos por facturar"
            href="/facturacion"
            value={pending.data?.total}
            resource={pending}
          />
          <Metric
            label="Facturas en borrador"
            href="/facturacion"
            value={drafts.data?.total}
            resource={drafts}
          />
        </dl>
        <p className="dashboard-summary-note">
          Las referencias de las listas de proveedores no equivalen a productos registrados.
          Asociarlas requiere el flujo de identificación.
        </p>
      </section>
      <div className="dashboard-columns">
        <section className="catalog-panel" aria-labelledby="dashboard-tasks-title">
          <div className="dashboard-section-heading">
            <div>
              <h2 id="dashboard-tasks-title">¿Qué hay que hacer hoy?</h2>
              <p>Pendientes guardados para continuar.</p>
            </div>
          </div>
          <div className="dashboard-task-group">
            <div className="dashboard-task-heading">
              <h3>Remitos por facturar</h3>
              <TaskCount total={pending.data?.total} />
            </div>
            {pending.loading && !pending.data && (
              <p className="dashboard-task-note" role="status">
                Buscando remitos pendientes…
              </p>
            )}
            {pending.error && (
              <p className="dashboard-task-note">
                No se pudieron actualizar estos pendientes. Reintentá desde el resumen.
              </p>
            )}
            {pending.data?.total === 0 && !pending.error && (
              <p className="dashboard-empty">No hay remitos confirmados pendientes de facturar.</p>
            )}
            {pending.data && (
              <ul className="dashboard-items">
                {pending.data.items.map((d) => (
                  <li key={d.id}>
                    <Link className="dashboard-item-link" href={`/remitos/${d.id}`}>
                      <span>
                        <strong>Remito {d.number}</strong>
                        <small>{d.customer.name}</small>
                      </span>
                      <span className="dashboard-item-action">Ver remito →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {pending.data && pending.data.total > pending.data.items.length && (
              <Link href="/facturacion" className="dashboard-inline-link">
                Ver los {number(pending.data.total)} remitos por facturar →
              </Link>
            )}
          </div>
          <div className="dashboard-task-group">
            <div className="dashboard-task-heading">
              <h3>Facturas en borrador</h3>
              <TaskCount total={drafts.data?.total} />
            </div>
            {drafts.loading && !drafts.data && (
              <p className="dashboard-task-note" role="status">
                Buscando borradores…
              </p>
            )}
            {drafts.error && (
              <p className="dashboard-task-note">
                No se pudieron actualizar estos borradores. Reintentá desde el resumen.
              </p>
            )}
            {drafts.data?.total === 0 && !drafts.error && (
              <p className="dashboard-empty">No hay facturas en borrador.</p>
            )}
            {drafts.data && (
              <ul className="dashboard-items">
                {drafts.data.items.map((i) => (
                  <li key={i.id}>
                    <Link className="dashboard-item-link" href={`/facturacion/${i.id}`}>
                      <span>
                        <strong>{i.customer.name}</strong>
                        <small>
                          {internalReference(i.id)} · {formatMoney(i.totalAmount)}
                        </small>
                      </span>
                      <span className="dashboard-item-action">
                        {isAdmin ? 'Completar' : 'Consultar'} →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {drafts.data && drafts.data.total > drafts.data.items.length && (
              <p className="dashboard-task-note">
                Mostrando {drafts.data.items.length} de {number(drafts.data.total)} borradores. El
                resto está en Facturación → Facturas.
              </p>
            )}
          </div>
          {readyInvoices.loading && !readyInvoices.data && (
            <p className="dashboard-task-note" role="status">
              Buscando comprobantes para revisar…
            </p>
          )}
          <ResourceError resource={readyInvoices} subject="los comprobantes listos" />
          {fiscalPending.length > 0 && (
            <div className="dashboard-task-group">
              <div className="dashboard-task-heading">
                <h3>Facturas para revisar</h3>
              </div>
              <p className="dashboard-task-note">
                Entre los últimos {readyInvoices.data!.items.length} comprobantes listos. Los
                autorizados no se muestran como pendientes.
              </p>
              <ul className="dashboard-items">
                {fiscalPending.map((i) => (
                  <li key={i.id}>
                    <Link className="dashboard-item-link" href={`/facturacion/${i.id}`}>
                      <span>
                        <strong>{i.customer.name}</strong>
                        <small>
                          {i.fiscalStatus ? invoiceFiscalStatusLabels[i.fiscalStatus] : ''} ·{' '}
                          {formatMoney(i.totalAmount)}
                        </small>
                      </span>
                      <span className="dashboard-item-action">
                        {isAdmin ? 'Revisar' : 'Consultar'} →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {resumable.length > 0 && (
            <div className="dashboard-task-group">
              <div className="dashboard-task-heading">
                <h3>Ingresos para retomar</h3>
              </div>
              <p className="dashboard-task-note">
                Borradores entre los últimos {receipts.data!.items.length} ingresos visibles.
              </p>
              <ul className="dashboard-items">
                {resumable.map((r) => (
                  <li key={r.id}>
                    <Link className="dashboard-item-link" href={`/inventario/ingresos/${r.id}`}>
                      <span>
                        <strong>{r.supplier?.name ?? 'Ingreso guardado'}</strong>
                        <small>{r.location.name}</small>
                      </span>
                      <span className="dashboard-item-action">Retomar →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section
          className="catalog-panel dashboard-activity"
          aria-labelledby="dashboard-activity-title"
        >
          <div className="dashboard-section-heading">
            <div>
              <h2 id="dashboard-activity-title">Actividad reciente</h2>
              <p>Los últimos ingresos creados que podés consultar.</p>
            </div>
          </div>
          {receipts.loading && !receipts.data && (
            <p className="dashboard-task-note" role="status">
              Cargando ingresos recientes…
            </p>
          )}
          <ResourceError resource={receipts} subject="los ingresos recientes" />
          {receipts.data?.items.length === 0 && !receipts.error && (
            <p className="dashboard-empty">
              Todavía no hay ingresos registrados. Cuando se guarde uno, aparecerá acá.
            </p>
          )}
          {receipts.data && (
            <ul className="dashboard-items">
              {receipts.data.items.map((r) => (
                <li key={r.id}>
                  <Link className="dashboard-item-link" href={`/inventario/ingresos/${r.id}`}>
                    <span>
                      <strong>{r.supplier?.name ?? 'Ingreso de productos'}</strong>
                      <small>
                        Creado <time dateTime={r.createdAt}>{dateTime(r.createdAt)}</time>
                      </small>
                    </span>
                    <span className="dashboard-status" data-status={r.status}>
                      {
                        { DRAFT: 'Borrador', CONFIRMED: 'Confirmado', CANCELLED: 'Cancelado' }[
                          r.status
                        ]
                      }
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link className="dashboard-inline-link" href="/inventario/ingresos">
            Ver todos los ingresos →
          </Link>
        </section>
      </div>
      <ConnectionStatus />
    </div>
  );
}
export function Home() {
  const { isAdmin } = useWorkspace();
  return <HomeDashboard key={isAdmin ? 'admin' : 'operator'} isAdmin={isAdmin} />;
}
