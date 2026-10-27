import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { act, useState, type ReactNode } from 'react';
import type { DeliveryNoteView } from '@maxbio/contracts';
import type { DeclaredTrace } from '../src/lib/delivery-traces.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { DocumentaryTraceEditor, SerialHistoryReview } =
  await import('../src/components/delivery-notes/trace-editor.js');
const originalFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
async function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  globalThis.fetch = originalFetch;
});

test('Stage 5 UI manual: agregar, editar con procedencia manual y quitar, sin depender de Stock', async () => {
  let current: DeclaredTrace[] = [];
  function Harness() {
    const [traces, setTraces] = useState<DeclaredTrace[]>([]);
    current = traces;
    return <DocumentaryTraceEditor traces={traces} change={setTraces} />;
  }
  await mount(<Harness />);
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
  assert.equal(current.length, 1);
  assert.match(container.textContent!, /Registrado solo en el Remito/);
  assert.equal(container.querySelectorAll('input').length, 4);
  const lot = container.querySelectorAll('input')[1]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      lot,
      'MANUAL-ABC',
    );
    lot.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(current[0]!.lotNumber, 'MANUAL-ABC');
  assert.equal(current[0]!.manualEdited, true);
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Quitar datos físicos')!
      .click(),
  );
  assert.deepEqual(current, []);
});

test('Stage 5 UI: antecedente histórico requiere revisión expresa antes de confirmar', async () => {
  const prior = randomUUID(),
    other = randomUUID();
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).serialNumber, 'S1');
    return Response.json({
      items: [
        {
          traceId: prior,
          deliveryNoteId: other,
          productId: product,
          documentNumber: '1-7',
          customerName: 'Cliente anterior',
          documentDate: '2026-10-26',
          lotNumber: 'ABC',
          serialNumber: 'S1',
          quantity: '1',
        },
      ],
      truncated: false,
    });
  };
  const product = randomUUID();
  const doc = {
    id: randomUUID(),
    lines: [{ productId: product, physicalTraces: [{ serialNumber: 'S1' }] }],
  } as unknown as DeliveryNoteView;
  let reviewed: string[] | null = null;
  const ready = (ids: string[] | null) => {
    reviewed = ids;
  };
  await mount(<SerialHistoryReview doc={doc} ready={ready} />);
  assert.equal(reviewed, null);
  assert.match(container.textContent!, /Remito anterior/);
  assert.match(container.textContent!, /Cliente anterior/);
  await act(async () =>
    (container.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
  );
  assert.deepEqual(reviewed, [prior]);
});
