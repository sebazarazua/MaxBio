'use client';
import { useState } from 'react';
import { deliveryNoteNumberingSchema, deliveryNoteNumberingInputSchema } from '@maxbio/contracts';
import { catalogFetch, humanError } from '@/lib/catalog-api';
import { Field, Feedback, useResource } from '../catalog/common';

export function DeliveryNoteNumberingSettings() {
  const resource = useResource('numbering', deliveryNoteNumberingSchema, 'delivery-notes');
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [prefix, setPrefix] = useState(''),
    [next, setNext] = useState('');
  return (
    <details className="catalog-panel" id="numeracion">
      <summary>Numeración de remitos</summary>
      <Feedback {...resource} reload={resource.reload} />
      {resource.data && (
        <>
          <p>
            Prefijo actual: <strong>{resource.data.prefix ?? 'Sin configurar'}</strong>
          </p>
          <p>
            Próximo número:{' '}
            <strong>
              {resource.data.suggestedNumber ??
                (resource.data.configured ? 'Talonario agotado' : 'Sin configurar')}
            </strong>
          </p>
          {!editing && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setPrefix(resource.data!.prefix ?? '');
                setNext(resource.data!.suggestedNumber ?? '');
                setEditing(true);
              }}
            >
              Cambiar numeración
            </button>
          )}
          {editing && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                const parsed = deliveryNoteNumberingInputSchema.safeParse({
                  prefix,
                  nextNumber: next,
                  expectedVersion: resource.data!.version,
                });
                if (!parsed.success) {
                  setError('Ingresá solo dígitos, conservando los ceros del talonario.');
                  return;
                }
                setBusy(true);
                setError('');
                try {
                  await catalogFetch('numbering', deliveryNoteNumberingSchema, {
                    scope: 'delivery-notes',
                    method: 'PUT',
                    body: parsed.data,
                  });
                  setEditing(false);
                  resource.reload();
                } catch (e) {
                  setError(humanError(e));
                  resource.reload();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>
                Usá el prefijo y el próximo número del papel físico. El ajuste se registra en el
                historial.
              </p>
              <fieldset disabled={busy}>
                <div className="form-grid">
                  <Field label="Prefijo actual">
                    <input
                      inputMode="numeric"
                      maxLength={12}
                      required
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                    />
                  </Field>
                  <Field label="Próximo número">
                    <input
                      inputMode="numeric"
                      maxLength={12}
                      required
                      value={next}
                      onChange={(e) => setNext(e.target.value)}
                    />
                  </Field>
                </div>
                <button type="submit" className="primary-button">
                  Guardar numeración
                </button>{' '}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setEditing(false)}
                >
                  Cancelar
                </button>
              </fieldset>
            </form>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="catalog-error">
          {error}
        </p>
      )}
    </details>
  );
}
