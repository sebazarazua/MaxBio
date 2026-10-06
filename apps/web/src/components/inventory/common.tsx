'use client';
import { useEffect, useRef, useState } from 'react';
import { inventoryPolicySchema, type InventoryPolicyInput } from '@maxbio/contracts';
import { inventoryFetch } from '@/lib/inventory-api';
import { humanError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { Feedback } from '../catalog/common';

export const conditionLabels = {
  USABLE: 'Utilizable',
  DAMAGED: 'Dañado',
  QUARANTINE: 'En cuarentena',
};
export const documentLabels = {
  DRAFT: 'Borrador',
  CONFIRMED: 'Confirmado',
  CANCELLED: 'Cancelado',
};
export const quantityLabels = {
  UNIT: 'unidades',
  PAIR: 'pares',
  METER: 'metros',
  CENTIMETER: 'centímetros',
  LITER: 'litros',
  MILLILITER: 'mililitros',
  KILOGRAM: 'kilogramos',
  GRAM: 'gramos',
};
export function useInventoryResource<T>(path: string, schema: { parse(input: unknown): T }) {
  const [revision, setRevision] = useState(0);
  const key = path + ':' + revision;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>({ key: '' });
  useEffect(() => {
    const controller = new AbortController();
    void inventoryFetch(path, schema, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setResult({ key, error: humanError(e) });
      });
    return () => controller.abort();
  }, [path, schema, key]);
  return {
    data: result.key === key ? result.data : undefined,
    error: result.key === key ? result.error : undefined,
    loading: result.key !== key,
    reload: () => setRevision((n) => n + 1),
  };
}
export function useInventoryMutation() {
  const guard = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run<T>(
    fn: () => Promise<T>,
    failed?: (e: unknown) => void,
  ): Promise<T | undefined> {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(humanError(e));
      failed?.(e);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run, clear: () => setError('') };
}
export function InventoryPolicyEditor({
  productId,
  policy,
  onSaved,
}: {
  productId: string;
  policy: {
    version: number;
    lotRequired: boolean;
    expirationRequired: boolean;
    serialRequired: boolean;
  } | null;
  onSaved: (p: ReturnType<typeof inventoryPolicySchema.parse>) => void | Promise<void>;
}) {
  const { isAdmin } = useWorkspace();
  const mutation = useInventoryMutation();
  const [lot, setLot] = useState(policy?.lotRequired ?? false),
    [expiration, setExpiration] = useState(policy?.expirationRequired ?? false),
    [serial, setSerial] = useState(policy?.serialRequired ?? false);
  if (!isAdmin)
    return policy ? null : (
      <p role="status">
        Un administrador debe revisar qué datos físicos necesita este producto antes de ingresarlo o
        contarlo.
      </p>
    );
  return (
    <section className="catalog-panel">
      <h3>{policy ? 'Datos físicos del producto' : 'Antes del primer ingreso o conteo'}</h3>
      <p>
        Revisá si este artículo necesita lote, vencimiento o una serie por unidad. Las tres opciones
        comienzan desmarcadas.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void mutation.run(async () => {
            const body: InventoryPolicyInput = {
              expectedVersion: policy?.version ?? 0,
              lotRequired: lot,
              expirationRequired: expiration,
              serialRequired: serial,
            };
            const result = await inventoryFetch(
              `products/${productId}/policy`,
              inventoryPolicySchema,
              { method: 'PUT', body },
            );
            await onSaved(result);
          });
        }}
      >
        <fieldset disabled={mutation.busy}>
          <label className="check-field">
            <input type="checkbox" checked={lot} onChange={(e) => setLot(e.target.checked)} />{' '}
            Requiere lote
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={expiration}
              onChange={(e) => setExpiration(e.target.checked)}
            />{' '}
            Requiere vencimiento
          </label>
          <label className="check-field">
            <input type="checkbox" checked={serial} onChange={(e) => setSerial(e.target.checked)} />{' '}
            Requiere serie individual
          </label>
        </fieldset>
        <button className="secondary-button" disabled={mutation.busy}>
          {mutation.busy ? 'Guardando…' : 'Guardar requisitos'}
        </button>
        <Feedback error={mutation.error} />
      </form>
    </section>
  );
}
