'use client';
import Link from 'next/link';
import { customerKindLabels, customerSchema } from '@maxbio/contracts';
import { useWorkspace } from '../workspace';
import { ArchiveAction, Feedback, Status, useMutation, useResource } from '../catalog/common';
import { customersFetch } from '@/lib/customers-api';
import { formatCuit } from './presentation';

export function CustomerDetail({ id }: { id: string }) {
  const { isAdmin } = useWorkspace();
  const resource = useResource(id, customerSchema, 'customers');
  const mutation = useMutation();
  const customer = resource.data;
  async function state() {
    if (!customer) return;
    const result = await mutation.run(() =>
      customersFetch(id + (customer.archivedAt ? '/restore' : '/archive'), customerSchema, {
        method: 'POST',
        body: { expectedVersion: customer.version },
      }),
    );
    if (result) resource.reload();
  }
  if (!customer) return <Feedback {...resource} />;
  const fields = [
    ['Razón social', customer.legalName],
    ['CUIT', customer.cuit ? formatCuit(customer.cuit) : null],
    ['Condición fiscal', customer.taxConditionText],
    ['Dirección', customer.addressLine],
    ['Localidad', customer.locality],
    ['Provincia', customer.province],
    ['Código postal', customer.postalCode],
    ['Persona de contacto', customer.contactName],
    ['Teléfono', customer.phone],
    ['Email', customer.email],
  ];
  return (
    <>
      <Link className="back-link" href="/clientes">
        ← Clientes
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">FICHA DE CLIENTE</p>
          <h1>{customer.name}</h1>
          <p className="page-intro">{customerKindLabels[customer.kind]}</p>
        </div>
        <Status archived={customer.archivedAt} />
      </div>
      {isAdmin && (
        <div className="actions">
          {!customer.archivedAt && (
            <Link className="primary-button" href={'/clientes/' + id + '/editar'}>
              Editar cliente
            </Link>
          )}
          <ArchiveAction
            archived={customer.archivedAt}
            busy={mutation.busy || resource.loading}
            action={state}
            label="este cliente"
          />
        </div>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? resource.reload : undefined} />
      <Feedback
        error={resource.error}
        loading={resource.loading}
        data={customer}
        reload={resource.reload}
      />
      <section className="catalog-panel">
        <h2>Datos comerciales y de contacto</h2>
        <dl className="data-grid">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || 'No informado'}</dd>
            </div>
          ))}
        </dl>
        <div className="description">
          <h2>Observaciones</h2>
          <p>{customer.notes || 'Sin observaciones.'}</p>
        </div>
      </section>
    </>
  );
}
