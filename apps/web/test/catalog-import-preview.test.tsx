import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { catalogImportRowsSchema } from '@maxbio/contracts';
import { CatalogImportPreviewTable } from '../src/components/catalog/catalog-import-preview-table.js';

const row = catalogImportRowsSchema.parse({
  page: 1,
  limit: 25,
  total: 1,
  items: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      rowNumber: 17,
      outcome: 'CREATED',
      itemId: null,
      supplierCode: '00-a/B',
      messages: [],
      data: {
        internalReferenceCode: null,
        supplierCode: '00-a/B',
        description: 'Walker corta',
        brandText: 'Marca declarada',
        manufacturerText: 'Fabricante declarado',
        modelText: 'Modelo declarado',
        categoryText: 'Categoría declarada',
        presentationText: 'Caja declarada',
        unitText: 'Par declarado',
        alternateSupplierCode: 'ALT-123',
        reportedGtin: '4006381333931',
        normalizedReportedGtin: '04006381333931',
        price: '218505.12',
        currency: 'ARS',
        vatRate: '21',
        priceIncludesVat: 'NO',
      },
    },
  ],
}).items[0]!;

test('preview compacta: ocho columnas principales y datos secundarios en detalles nativos accesibles', () => {
  const html = renderToStaticMarkup(<CatalogImportPreviewTable rows={[row]} />);
  assert.equal((html.match(/<th /g) ?? []).length, 8);
  assert.equal((html.match(/<td[ >]/g) ?? []).length, 8);
  assert.match(html, /Nueva referencia/);
  assert.match(html, /\$ 218\.505,12/);
  const details = html.slice(html.indexOf('<details'));
  assert.match(details, /<summary>Ver detalles/);
  assert.doesNotMatch(details.slice(0, details.indexOf('>')), /open/);
  for (const value of [
    'ALT-123',
    'Fabricante declarado',
    'Modelo declarado',
    'Categoría declarada',
    'Caja declarada',
    'Par declarado',
    '4006381333931',
    '04006381333931',
    'ARS',
    '<dd>No</dd>',
  ])
    assert.ok(details.includes(value), value);
  assert.doesNotMatch(
    html,
    /<select|headerRow|sheetName|supplierCode|Guardar este formato|Confirmar ARS/,
  );
});

test('errores/conflictos y advertencias quedan visibles; filas problemáticas tienen detalle abierto', () => {
  for (const outcome of ['ERROR', 'CONFLICT'] as const) {
    const html = renderToStaticMarkup(
      <CatalogImportPreviewTable rows={[{ ...row, outcome, messages: ['Revisá este dato.'] }]} />,
    );
    assert.ok(html.indexOf('Revisá este dato.') < html.indexOf('<details'));
    assert.match(html, /<details[^>]* open=""/);
  }
  const html = renderToStaticMarkup(
    <CatalogImportPreviewTable
      rows={[{ ...row, messages: ['Valor guardado: puede estar desactualizado.'] }]}
    />,
  );
  assert.ok(html.indexOf('Valor guardado:') < html.indexOf('<details'));
});

test('códigos existentes siguen visibles; moneda explícita y datos ausentes no se inventan', () => {
  const html = renderToStaticMarkup(
    <CatalogImportPreviewTable
      rows={[
        {
          ...row,
          outcome: 'UPDATED',
          data: {
            ...row.data!,
            internalReferenceCode: 'AA000143',
            currency: 'USD',
            manufacturerText: null,
          },
        },
      ]}
    />,
  );
  assert.match(html, /AA000143/);
  assert.match(html, /USD 218\.505,12/);
  assert.match(html, /<dt>Fabricante<\/dt><dd>—<\/dd>/);
  const invalid = renderToStaticMarkup(
    <CatalogImportPreviewTable
      rows={[{ ...row, outcome: 'ERROR', data: null, messages: ['Precio inválido.'] }]}
    />,
  );
  assert.match(invalid, /Precio inválido/);
  assert.match(invalid, /00-a\/B/);
  assert.doesNotMatch(invalid, /Nueva referencia|218\.505/);
});
