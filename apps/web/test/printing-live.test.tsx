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
const { PrintTrialDialog } = await import('../src/components/printing/print-trial-dialog.js');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000',
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
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

test('Print trial: visible modal, background preview, overlay download and close restore focus', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const downloads: string[] = [];
  const createUrl = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:trial';
  const click = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.href);
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(new Uint8Array([65]), { headers: { 'Content-Type': 'application/pdf' } });
  };
  let closed = false;
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  try {
    await mount(
      <PrintTrialDialog
        template={template}
        calibration={null}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    assert.equal(container.querySelector('dialog')?.open, true);
    assert.match(container.textContent!, /Prueba de impresión/);
    assert.equal(container.querySelector('[data-pdf]')?.getAttribute('data-pdf'), 'A');
    assert.equal(requests[0]!.path, '/api/printing/print-test-preview');
    const download = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Descargar impresión de prueba',
    )!;
    await act(async () => {
      download.click();
    });
    assert.equal(requests[1]!.path, '/api/printing/print-test');
    assert.deepEqual(requests[1]!.body, { templateRevisionId: template.id, calibrationId: null });
    assert.equal(
      requests.some((r) => r.path.includes('calibration-test')),
      false,
    );
    assert.deepEqual(downloads, ['blob:trial']);
    await act(async () => {
      container.querySelector('button')!.click();
    });
    assert.equal(closed, true);
    await act(async () => {
      root!.unmount();
      root = undefined;
    });
    assert.equal(document.activeElement, opener);
  } finally {
    URL.createObjectURL = createUrl;
    dom.window.HTMLAnchorElement.prototype.click = click;
  }
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
    await wait(350);
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
    await wait(350);
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

function pointer(target: Element, type: string, x = 10, y = 20) {
  target.dispatchEvent(
    new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }),
  );
}
function svgSize() {
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
  return svg;
}
function geometryReply(body: { definition: typeof template.definition }, letter = 'A') {
  return {
    ...result(letter),
    envelopes: body.definition.fields.map((f) => ({
      region: f.id,
      rect: { xMm: f.xMm, yMm: f.yMm, widthMm: 30, heightMm: 10 },
      state: 'SAFE',
    })),
  };
}

test('Drag stress: 120 movimientos sin requests, commit único, cancelaciones y clamp', async () => {
  const bodies: { definition: typeof template.definition }[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json(geometryReply(body));
  };
  await mount(<PrintGeometryEditor template={template} calibration={null} onSaved={() => {}} />);
  await act(async () => {
    await wait(350);
  });
  const svg = svgSize();
  const customer = () => container.querySelector('[aria-label="Mover Cliente"]')!;
  const initial = bodies[0]!.definition.fields.find((f) => f.id === 'customer')!;
  await act(async () => {
    pointer(customer(), 'pointerdown');
  });
  for (let n = 0; n < 120; n++)
    await act(async () => {
      pointer(svg, 'pointermove', n % 2 ? 10 + n : 10 - n, 20 + (n % 23));
    });
  await act(async () => {
    pointer(svg, 'pointermove', 30, 40);
    await wait(380);
  });
  assert.equal(bodies.length, 1, 'No geometry-preview mientras el pointer sigue capturado');
  assert.equal(customer().getAttribute('aria-pressed'), 'true');
  assert.equal(svg.style.pointerEvents, 'auto');
  assert.equal(
    Number(customer().getAttribute('x')),
    Math.min(203 - initial.widthMm, initial.xMm + 10),
  );
  await act(async () => {
    pointer(svg, 'pointerup', 30, 40);
  });
  await act(async () => {
    await wait(350);
  });
  assert.equal(bodies.length, 2);
  assert.equal(
    bodies[1]!.definition.fields.find((f) => f.id === 'customer')!.xMm,
    Math.min(203 - initial.widthMm, initial.xMm + 10),
  );
  for (const cancel of ['pointercancel', 'lostpointercapture', 'Escape', 'change-field']) {
    await act(async () => {
      pointer(customer(), 'pointerdown');
      pointer(svg, 'pointermove', 200, 200);
    });
    await act(async () => {
      if (cancel === 'Escape')
        window.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      else if (cancel === 'change-field') {
        const select = container.querySelector('select')!;
        select.value = 'products';
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      } else pointer(svg, cancel);
    });
    await act(async () => {
      await wait(350);
    });
    assert.equal(bodies.length, 2, cancel);
  }
  await act(async () => {
    pointer(customer(), 'pointerdown');
    pointer(svg, 'pointermove', 10000, -10000);
    pointer(svg, 'pointerup');
  });
  await act(async () => {
    await wait(350);
  });
  const clamped = bodies.at(-1)!.definition.fields.find((f) => f.id === 'customer')!;
  assert.ok(clamped.xMm + clamped.widthMm <= 203);
  assert.equal(clamped.yMm, 0);
});

test('Productos resize local y spam de teclado: una reevaluación por commit', async () => {
  const bodies: { definition: typeof template.definition }[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json(geometryReply(body));
  };
  await mount(<PrintGeometryEditor template={template} calibration={null} onSaved={() => {}} />);
  await act(async () => {
    await wait(350);
  });
  const svg = svgSize();
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = 'products';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await act(async () => {
    pointer(container.querySelector('circle')!, 'pointerdown');
    for (let n = 0; n < 120; n++) pointer(svg, 'pointermove', 10 + n, 20 + n);
    await wait(380);
  });
  assert.equal(bodies.length, 1);
  await act(async () => {
    pointer(svg, 'pointerup');
  });
  await act(async () => {
    await wait(350);
  });
  assert.equal(bodies.length, 2);
  const r = bodies[1]!.definition.productRegion;
  assert.deepEqual(r.columns, template.definition.productRegion.columns);
  assert.equal(r.rowHeightMm, template.definition.productRegion.rowHeightMm);
  assert.ok(r.widthMm + r.xMm <= 203);
  assert.ok(r.heightMm + r.yMm <= 271);
  const customer = container.querySelector('[aria-label="Mover Cliente"]')!;
  await act(async () => {
    for (let n = 0; n < 10; n++)
      customer.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
  });
  await act(async () => {
    await wait(350);
  });
  assert.equal(bodies.length, 3);
  assert.equal(
    bodies.at(-1)!.definition.fields.find((f) => f.id === 'customer')!.yMm,
    template.definition.fields.find((f) => f.id === 'customer')!.yMm + 5,
  );
});

test('Vista ampliada con Escape y advertencias plegadas; BLOCKED visible', async () => {
  globalThis.fetch = async (url) =>
    String(url).endsWith('/config')
      ? Response.json({ activeTemplate: template, calibrations: [] })
      : Response.json({
          ...result(),
          evaluation: {
            ...evaluation,
            state: 'BLOCKED',
            issues: [
              { region: 'customer', state: 'WARNING', message: 'technical' },
              { region: 'dateDay', state: 'WARNING', message: 'technical' },
              { region: 'products', state: 'BLOCKED', message: 'technical' },
            ],
          },
        });
  await mount(<LiveDeliveryPreview input={{ lines: [] }} onValidation={() => {}} />);
  await act(async () => {
    await wait(260);
  });
  const details = container.querySelector('details')!;
  assert.equal(details.open, false);
  assert.match(details.textContent!, /Hay 2 datos/);
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Hay más productos/);
  await act(async () => {
    (container.querySelector('button') as HTMLButtonElement).click();
  });
  const dialog = container.querySelector('dialog')!;
  assert.equal(dialog.open, true);
  assert.equal(document.body.style.overflow, 'hidden');
  await act(async () => {
    dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(dialog.open, false);
  assert.equal(document.body.style.overflow, '');
});

test('Editor latest-wins: une réponse vieja no reemplaza el PDF actual y refresh no corta interacción', async () => {
  const pending: {
    body: { definition: typeof template.definition };
    signal: AbortSignal;
    resolve: (r: Response) => void;
  }[] = [];
  let first = true;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (first) {
      first = false;
      return Response.json(geometryReply(body));
    }
    return new Promise<Response>((resolve) =>
      pending.push({ body, signal: init!.signal!, resolve }),
    );
  };
  await mount(<PrintGeometryEditor template={template} calibration={null} onSaved={() => {}} />);
  await act(async () => {
    await wait(350);
  });
  const svg = svgSize();
  const customer = container.querySelector('[aria-label="Mover Cliente"]')!;
  await act(async () => {
    customer.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  await act(async () => {
    await wait(350);
  });
  assert.equal(svg.style.pointerEvents, 'auto');
  await act(async () => {
    customer.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  await act(async () => {
    await wait(350);
  });
  assert.equal(pending[0]!.signal.aborted, true);
  await act(async () => {
    pending[1]!.resolve(Response.json(geometryReply(pending[1]!.body, 'C')));
  });
  await act(async () => {
    pending[0]!.resolve(Response.json(geometryReply(pending[0]!.body, 'B')));
  });
  assert.equal(container.querySelector('[data-pdf]')!.getAttribute('data-pdf'), 'C');
});
