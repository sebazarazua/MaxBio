import type { PrintEvaluation, PrintTemplate } from '@maxbio/contracts';

export const printLabels: Record<string, string> = {
  'document.number': 'Número del remito',
  'document.date': 'Fecha',
  'document.dateDay': 'Día',
  'document.dateMonth': 'Mes',
  'document.dateYear': 'Año',
  'customer.name': 'Cliente',
  'customer.legalName': 'Razón social',
  'customer.cuit': 'CUIT',
  'customer.taxCondition': 'Condición fiscal',
  'customer.address': 'Domicilio',
  'customer.addressLine': 'Dirección',
  'customer.locality': 'Localidad',
  'patient.name': 'Paciente',
  'patient.affiliateNumber': 'N.º afiliado',
  notes: 'Observaciones',
  quantity: 'Cantidad',
  unit: 'Unidad',
  productName: 'Producto',
  presentation: 'Presentación',
  lotNumber: 'Lote',
  expirationDate: 'Vencimiento',
  serialNumber: 'Serie',
  scannedGtin: 'GTIN leído',
  products: 'Productos',
};
export function humanPrintMessage(message: string) {
  return Object.entries(printLabels).reduce(
    (text, [binding, label]) =>
      text.replace(new RegExp('\\b' + binding.replaceAll('.', '\\.') + '\\b', 'g'), label),
    message,
  );
}
export function printErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === 'ZodError')
    return 'Revisá el tamaño de los textos y su ubicación dentro del papel.';
  return humanPrintMessage(
    error instanceof Error ? error.message : 'No pudimos preparar el remito. Reintentá.',
  );
}
export function printRegionLabel(region: string, template: PrintTemplate) {
  const binding = template.definition.fields.find((f) => f.id === region)?.binding;
  return printLabels[binding ?? region.replace(/^row-\d+-/, '')] ?? 'Dato del remito';
}
export function printIssueMessage(
  issue: PrintEvaluation['issues'][number],
  template: PrintTemplate,
) {
  if (issue.state === 'WARNING')
    return `Revisá visualmente ${printRegionLabel(issue.region, template).toLocaleLowerCase('es')} antes de imprimir.`;
  if (issue.region === 'products')
    return 'Hay más productos de los que entran en este formulario. Prepará remitos separados.';
  if (/^product-/.test(issue.region)) return issue.message;
  return `${printRegionLabel(issue.region, template)} no entra correctamente en el espacio del remito. Revisá el dato o pedí ayuda a un administrador.`;
}
