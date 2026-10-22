import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  bourbonProvisionalTemplate,
  printTemplateSchema,
  printDraftPreviewInputSchema,
  type PrintDraftPreviewInput,
} from '@maxbio/contracts';

// Exercise interactions and request ordering; PDF rendering is covered by API tests.
mock.module('../src/components/printing/pdf-preview.js', {
  namedExports: {
    PdfPreview: ({
      bytes,
      children,
      onReady,
    }: {
      bytes: Uint8Array;
      children?: ReactNode;
      onReady?: () => void;
    }) => {
      useEffect(() => {
        onReady?.();
      }, [onReady]);
      return <div data-pdf={String.fromCharCode(bytes[0] ?? 0)}>{children}</div>;
    },
  },
});
const { LiveDeliveryPreview } = await import('../src/components/printing/live-delivery-preview.js');
const { PrintGeometryEditor } = await import('../src/components/printing/geometry-editor.js');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let container: HTMLDivElement;
const preset = bourbonProvisionalTemplate(randomUUID(), randomUUID());
const template = printTemplateSchema.parse({
  ...preset,
  familyId: preset.id,
  revision: 1,
  status: 'PUBLISHED',
  createdAt: '2026-10-22T12:00:00.000Z',
  updatedAt: '2026-10-22T12:00:00.000Z',
  publishedAt: '2026-10-22T12:00:00.000Z',
});
const evaluation = {
  state: 'SAFE',
  documentVersion: 1,
  templateRevisionId: template.id,
  rowCount: 0,
  maxRows: 10,
  issues: [],
};
const result = (text = 'A') => ({ pdfBase64: btoa(text), evaluation });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  globalThis.fetch = originalFetch;
});

test('Nuevo remito: background antes de guardar, debounce y cambios locales completos', async () => {
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/config'))
      return Response.json({ activeTemplate: template, calibrations: [] });
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json(result());
  };
  const validate = () => {};
  const draw = (input: PrintDraftPreviewInput) => (
    <LiveDeliveryPreview input={input} onValidation={validate} />
  );
  await mount(draw({ lines: [] }));
  assert.ok(container.querySelector('[aria-label="Formulario de remito vacío"]'));
  assert.equal(requests.length, 0);
  await act(async () => {
    await wait(260);
  });
  assert.deepEqual(requests[0], printDraftPreviewInputSchema.parse({ lines: [] }));
  assert.equal(container.querySelector('[data-pdf]')?.getAttribute('data-pdf'), 'A');
  assert.equal(container.querySelector('svg'), null);
  assert.doesNotMatch(container.textContent!, /OSUTHGRA|SAFE|WARNING|BLOCKED|JSON/);
  const input = {
    customerId: randomUUID(),
    documentDate: '2026-10-22',
    patientName: 'Paciente',
    affiliateNumber: 'AF-1',
    lines: [
      {
        productId: randomUUID(),
        quantity: '1',
        allocations: [{ positionId: randomUUID(), quantity: '1' }],
      },
    ],
  };
  await act(async () => {
    root!.render(draw(input));
  });
  await act(async () => {
    root!.render(draw({ ...input, patientName: 'Paciente actualizado' }));
  });
  await act(async () => {
    await wait(260);
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1],
    printDraftPreviewInputSchema.parse({ ...input, patientName: 'Paciente actualizado' }),
  );
});

test('Una respuesta vieja no reemplaza la última; se aborta y los errores no bloquean carga', async () => {
  const pending: { resolve: (r: Response) => void; signal: AbortSignal }[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/config'))
      return Response.json({ activeTemplate: template, calibrations: [] });
    return new Promise<Response>((resolve) => pending.push({ resolve, signal: init!.signal! }));
  };
  const validated: boolean[] = [];
  const validate = (ready: boolean) => validated.push(ready);
  const draw = (patientName: string) => (
    <LiveDeliveryPreview input={{ patientName, lines: [] }} onValidation={validate} />
  );
  await mount(draw('Primero'));
  await act(async () => {
    await wait(260);
  });
  await act(async () => {
    root!.render(draw('Último'));
  });
  await act(async () => {
    await wait(260);
  });
  assert.equal(pending[0]!.signal.aborted, true);
  await act(async () => {
    pending[1]!.resolve(Response.json(result('B')));
  });
  await act(async () => {
    pending[0]!.resolve(Response.json(result('A')));
  });
  assert.equal(container.querySelector('[data-pdf]')?.getAttribute('data-pdf'), 'B');
  assert.equal(validated.at(-1), true);
  await act(async () => {
    root!.render(draw('Siguiente'));
  });
  await act(async () => {
    await wait(260);
  });
  await act(async () => {
    pending[2]!.resolve(Response.json({ message: 'Error' }, { status: 503 }));
  });
  assert.match(container.textContent!, /Podés seguir completando|podés seguir completando/);
  assert.equal(validated.at(-1), false);
  assert.equal(container.querySelector('fieldset[disabled]'), null);
});

test('Editor visual: nombres humanos, click, drag en mm y coordenadas dentro de Ajuste preciso', async () => {
  const bodies: { definition: typeof template.definition }[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { definition: typeof template.definition };
    bodies.push(body);
    return Response.json({
      ...result(),
      envelopes: [
        {
          region: 'customer',
          rect: { xMm: 29, yMm: 56.5, widthMm: 90, heightMm: 10 },
          state: 'SAFE',
        },
      ],
    });
  };
  await mount(<PrintGeometryEditor template={template} calibration={null} onSaved={() => {}} />);
  assert.match(container.textContent!, /Ajustar ubicación de textos/);
  assert.doesNotMatch(container.textContent!, /customer\.name|document\.dateDay|JSON/);
  const precise = [...container.querySelectorAll('details')].find(
    (d) => d.querySelector('summary')?.textContent === 'Ajuste preciso',
  )!;
  assert.equal(precise.open, false);
  assert.ok(
    [...precise.querySelectorAll('label')].some((label) => label.textContent?.includes('X (mm)')),
  );
  await act(async () => {
    await wait(220);
  });
  const svg = container.querySelector('svg')!;
  svg.getBoundingClientRect = () => ({
    width: 406,
    height: 542,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 406,
    bottom: 542,
    toJSON: () => ({}),
  });
  svg.setPointerCapture = () => {};
  svg.hasPointerCapture = () => false;
  const rect = container.querySelector('[aria-label="Mover Cliente"]')!;
  await act(async () => {
    rect.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 20 }),
    );
  });
  assert.equal(rect.getAttribute('aria-pressed'), 'true');
  await act(async () => {
    svg.dispatchEvent(
      new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 26 }),
    );
    svg.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
  });
  await act(async () => {
    await wait(220);
  });
  const moved = bodies.at(-1)!.definition.fields.find((f) => f.id === 'customer')!;
  assert.equal(moved.xMm, 34);
  assert.equal(moved.yMm, 59.5);
  assert.equal(container.querySelectorAll('svg rect[aria-label="Mover Cliente"]').length, 1);
  precise.open = true;
  assert.equal(precise.open, true);
});

test('Sin plantilla activa no usa borradores ni pide renders operativos', async () => {
  let renders = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/config'))
      return Response.json({ activeTemplate: null, calibrations: [] });
    renders++;
    throw new Error('No debe renderizar un borrador');
  };
  await mount(<LiveDeliveryPreview input={{ lines: [] }} onValidation={() => {}} />);
  await act(async () => {
    await wait(260);
  });
  assert.match(container.textContent!, /Todavía no hay una plantilla de remito lista para usar/);
  assert.equal(renders, 0);
});
