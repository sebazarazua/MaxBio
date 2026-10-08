'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import {
  customerCreateSchema,
  customerUpdateSchema,
  customerKindLabels,
  customerSchema,
  type CustomerCreate,
  type CustomerUpdate,
  type CustomerView,
} from '@maxbio/contracts';
import { customersFetch } from '@/lib/customers-api';
import { CatalogHttpError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { Feedback, Field, useMutation, useResource } from '../catalog/common';

const groups = [
  {
    title: 'Datos comerciales y fiscales',
    fields: [
      { key: 'legalName', label: 'Razón social', max: 200 },
      { key: 'cuit', label: 'CUIT', max: 32, help: '11 dígitos o XX-XXXXXXXX-X. Es opcional.' },
      { key: 'taxConditionText', label: 'Condición fiscal', max: 80 },
    ],
  },
  {
    title: 'Domicilio',
    fields: [
      { key: 'addressLine', label: 'Dirección', max: 250 },
      { key: 'locality', label: 'Localidad', max: 120 },
      { key: 'province', label: 'Provincia', max: 100 },
      { key: 'postalCode', label: 'Código postal', max: 20 },
    ],
  },
  {
    title: 'Contacto',
    fields: [
      { key: 'contactName', label: 'Nombre de contacto', max: 160 },
      { key: 'phone', label: 'Teléfono', max: 50, type: 'tel' },
      { key: 'email', label: 'Email', max: 254, type: 'email' },
    ],
  },
] as const;

export function CustomerEditor({ id }: { id?: string }) {
  const { isAdmin } = useWorkspace();
  const resource = useResource(id ?? null, customerSchema, 'customers');
  if (!isAdmin)
    return (
      <>
        <h1>Consultar clientes</h1>
        <p>Un administrador puede modificar los clientes.</p>
        <Link href="/clientes">Volver a clientes</Link>
      </>
    );
  if (id && (!resource.data || resource.loading)) return <Feedback {...resource} />;
  if (resource.data?.archivedAt)
    return (
      <>
        <h1>Cliente archivado</h1>
        <p>Restaurá el cliente antes de editarlo.</p>
        <Link href={'/clientes/' + id}>Volver a la ficha</Link>
      </>
    );
  return (
    <CustomerForm
      key={resource.data?.version ?? 'new'}
      customer={resource.data}
      reload={resource.reload}
    />
  );
}

function CustomerForm({ customer, reload }: { customer?: CustomerView; reload: () => void }) {
  const router = useRouter();
  const mutation = useMutation();
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  const guard = useRef(false);
  const createId = useRef<string | null>(null);
  const attempt = useRef<CustomerCreate | CustomerUpdate | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const errorId = (key: string) => formId + '-' + key + '-error';
  function fieldError(key: string) {
    return errors[key] ? (
      <small id={errorId(key)} role="alert">
        {errors[key]}
      </small>
    ) : null;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guard.current) return;
    setNotice('');
    if (!attempt.current) {
      const data = new FormData(event.currentTarget);
      const fields = Object.fromEntries(data.entries());
      if (!customer && !createId.current) createId.current = crypto.randomUUID();
      const parsed = customer
        ? customerUpdateSchema.safeParse({ ...fields, expectedVersion: customer.version })
        : customerCreateSchema.safeParse({ ...fields, id: createId.current });
      if (!parsed.success) {
        const next: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0]);
          next[key] ??=
            issue.code === 'too_big'
              ? `Usá hasta ${String(issue.maximum)} caracteres.`
              : key === 'kind'
                ? 'Elegí el tipo de cliente.'
                : key === 'cuit'
                  ? 'Revisá el CUIT: usá 11 dígitos y un dígito verificador válido.'
                  : issue.message;
        }
        setErrors(next);
        const input = event.currentTarget.elements.namedItem(Object.keys(next)[0]!);
        if (input instanceof HTMLElement) {
          const details = input.closest('details');
          if (details) details.open = true;
          input.focus();
        }
        return;
      }
      setErrors({});
      attempt.current = parsed.data;
    }
    guard.current = true;
    const result = await mutation.run(async () => {
      try {
        return await customersFetch(customer?.id ?? '', customerSchema, {
          method: customer ? 'PATCH' : 'POST',
          body: attempt.current,
        });
      } catch (cause) {
        if (cause instanceof CatalogHttpError && cause.status < 500) {
          attempt.current = null;
          setUncertain(false);
        } else setUncertain(true);
        throw cause;
      }
    });
    guard.current = false;
    if (result) {
      attempt.current = null;
      setUncertain(false);
      router.push('/clientes/' + result.id);
    }
  }
  async function check() {
    if (guard.current) return;
    const id = customer?.id ?? createId.current;
    if (!id) return;
    guard.current = true;
    await mutation.run(async () => {
      try {
        const current = await customersFetch(id, customerSchema);
        if (customer && current.version === customer.version) {
          attempt.current = null;
          setUncertain(false);
          setNotice(
            'El cliente conserva la información anterior. Podés revisar y volver a guardar.',
          );
        } else router.push('/clientes/' + current.id);
      } catch (cause) {
        if (!customer && cause instanceof CatalogHttpError && cause.status === 404) {
          attempt.current = null;
          setUncertain(false);
          setNotice('Todavía no se encontró este cliente. Podés revisar y volver a guardar.');
        } else throw cause;
      }
    });
    guard.current = false;
  }
  return (
    <>
      <Link className="back-link" href={customer ? '/clientes/' + customer.id : '/clientes'}>
        ← Clientes
      </Link>
      <p className="eyebrow">PERSONAS</p>
      <h1>{customer ? 'Editar cliente' : 'Nuevo cliente'}</h1>
      <p className="page-intro">Completá el nombre y el tipo. Los demás datos son opcionales.</p>
      <form
        ref={form}
        className="catalog-panel catalog-form"
        noValidate
        onSubmit={(event) => void save(event)}
      >
        <fieldset disabled={mutation.busy || uncertain || (mutation.conflict && Boolean(customer))}>
          <Field label="Nombre *">
            <input
              name="name"
              required
              maxLength={200}
              defaultValue={customer?.name ?? ''}
              autoFocus
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? errorId('name') : undefined}
            />
            {fieldError('name')}
          </Field>
          <Field label="Tipo *">
            <select
              name="kind"
              required
              defaultValue={customer?.kind ?? ''}
              aria-invalid={Boolean(errors.kind)}
              aria-describedby={errors.kind ? errorId('kind') : undefined}
            >
              <option value="" disabled>
                Elegí el tipo de cliente
              </option>
              {Object.entries(customerKindLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {fieldError('kind')}
          </Field>
          {groups.map((group) => (
            <details className="form-details" key={group.title}>
              <summary>{group.title}</summary>
              <div className="form-grid">
                {group.fields.map((field) => (
                  <Field
                    key={field.key}
                    label={field.label}
                    help={'help' in field ? field.help : undefined}
                  >
                    <input
                      name={field.key}
                      type={'type' in field ? field.type : 'text'}
                      maxLength={field.max}
                      defaultValue={customer?.[field.key] ?? ''}
                      aria-invalid={Boolean(errors[field.key])}
                      aria-describedby={errors[field.key] ? errorId(field.key) : undefined}
                    />
                    {fieldError(field.key)}
                  </Field>
                ))}
              </div>
            </details>
          ))}
          <details className="form-details">
            <summary>Observaciones</summary>
            <Field
              label="Notas comerciales"
              help="Solo información comercial; sin datos de pacientes."
            >
              <textarea
                name="notes"
                rows={4}
                maxLength={1000}
                defaultValue={customer?.notes ?? ''}
                aria-invalid={Boolean(errors.notes)}
                aria-describedby={errors.notes ? errorId('notes') : undefined}
              />
              {fieldError('notes')}
            </Field>
          </details>
        </fieldset>
        <Feedback error={mutation.error} />
        {uncertain && (
          <div className="catalog-notice" role="status">
            <p>
              No pudimos comprobar si se guardó. Reintentá con los mismos datos o comprobá el
              resultado.
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={mutation.busy}
              onClick={() => void check()}
            >
              Comprobar resultado
            </button>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {mutation.conflict && customer && !uncertain && (
          <div className="catalog-notice">
            <p>
              Cargá la ficha actual y revisá los datos. Se descartarán los cambios de este
              formulario.
            </p>
            <button type="button" className="secondary-button" onClick={reload}>
              Cargar información actual
            </button>
          </div>
        )}
        <div className="form-actions">
          <Link
            className="secondary-button"
            href={customer ? '/clientes/' + customer.id : '/clientes'}
          >
            Cancelar
          </Link>
          <button
            className="primary-button"
            type="submit"
            disabled={mutation.busy || (mutation.conflict && Boolean(customer) && !uncertain)}
          >
            {mutation.busy ? 'Guardando…' : uncertain ? 'Reintentar guardado' : 'Guardar cliente'}
          </button>
        </div>
      </form>
    </>
  );
}
