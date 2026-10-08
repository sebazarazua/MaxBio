'use client';
import Link from 'next/link';
import { customerKindLabels, customerListSchema } from '@maxbio/contracts';
import { useWorkspace } from '../workspace';
import { Feedback, Pagination, SearchBar, Status, useResource, useSearch } from '../catalog/common';
import { formatCuit } from './presentation';

export function CustomersList() {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const resource = useResource('?' + search.query, customerListSchema, 'customers');
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PERSONAS</p>
          <h1>Clientes</h1>
          <p className="page-intro">Obras sociales, instituciones y otros clientes comerciales.</p>
        </div>
        {isAdmin && (
          <Link href="/clientes/nuevo" className="primary-button">
            + Nuevo cliente
          </Link>
        )}
      </div>
      <SearchBar state={search} placeholder="Nombre, razón social, CUIT o contacto" />
      <Feedback {...resource} />
      {resource.data && (
        <>
          <div className="record-list">
            {resource.data.items.map((customer) => (
              <Link key={customer.id} href={'/clientes/' + customer.id} className="record-row">
                <div>
                  <h2>{customer.name}</h2>
                  <p className="muted">
                    {customerKindLabels[customer.kind]} ·{' '}
                    {customer.cuit ? 'CUIT ' + formatCuit(customer.cuit) : 'CUIT no informado'}
                  </p>
                  <p className="muted">
                    {[customer.contactName, customer.phone, customer.email]
                      .filter(Boolean)
                      .join(' · ') || 'Contacto no informado'}
                  </p>
                </div>
                <span>
                  <Status archived={customer.archivedAt} />
                  <span className="row-arrow" aria-hidden="true">
                    →
                  </span>
                </span>
              </Link>
            ))}
          </div>
          {resource.data.items.length === 0 && (
            <div className="empty-state">
              <h2>{search.q ? 'No encontramos clientes' : 'Todavía no hay clientes'}</h2>
              <p>
                {search.q
                  ? 'Probá con otro dato o incluí archivados.'
                  : isAdmin
                    ? 'Creá un cliente con su nombre y tipo. Los demás datos son opcionales.'
                    : 'Un administrador puede crear los clientes comerciales.'}
              </p>
            </div>
          )}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
    </>
  );
}
