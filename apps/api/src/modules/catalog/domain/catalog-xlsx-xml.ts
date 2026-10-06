import { Parser } from 'saxen';
import { supplierCatalogLimits as limits } from '@maxbio/contracts';
import { CatalogRuleError } from './identifiers.js';

export interface XlsxXmlMetadata {
  sheets: { name: string; relationshipId: string }[];
  relationships: Record<string, string>;
  rowCounts: Record<string, number>;
}
const localName = (name: string) => name.split(':').at(-1)!;
export function validateXlsxXml(xml: string, path: string, metadata: XlsxXmlMetadata) {
  const parser = new Parser();
  const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(path);
  let depth = 0;
  let nodes = 0;
  let rows = 0;
  let cells = 0;
  let cellsInRow = 0;
  let maximumRow = 0;
  const tooLarge = () => {
    throw new CatalogRuleError(
      'El Excel supera 10.000 filas de artículos o 100 columnas. Eliminá celdas fuera de la lista.',
    );
  };
  const checkAddress = (value: string) => {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(value);
    if (!match || value.length > 12)
      throw new CatalogRuleError(
        'El Excel tiene referencias de celda inválidas. Guardá una copia nueva.',
      );
    let column = 0;
    for (const char of match[1]!) column = column * 26 + char.charCodeAt(0) - 64;
    const row = Number(match[2]);
    if (column > limits.columns || row > limits.rows + 20) tooLarge();
    maximumRow = Math.max(maximumRow, row);
  };
  const invalidXml = () => {
    throw new CatalogRuleError(
      'No pudimos leer el XML de este Excel. Guardá una copia .xlsx nueva.',
    );
  };
  parser
    .on('error', invalidXml)
    .on('warn', invalidXml)
    .on('attention', () => {
      throw new CatalogRuleError('No se admiten entidades ni declaraciones XML externas.');
    });
  parser.on('openTag', (rawName, getAttributes, decode) => {
    const name = localName(rawName);
    const attributes = Object.fromEntries(
      Object.entries(getAttributes()).map(([key, value]) => [localName(key), decode(value)]),
    );
    if (++depth > 64 || ++nodes > 2000000)
      throw new CatalogRuleError(
        'El Excel tiene una estructura demasiado compleja. Usá una lista simple.',
      );
    if (
      name === 'f' ||
      name === 'hyperlink' ||
      attributes.TargetMode?.toLowerCase() === 'external' ||
      Object.values(attributes).some((value) => /macroEnabled/i.test(value))
    )
      throw new CatalogRuleError(
        'El Excel contiene fórmulas, macros o enlaces externos. Guardá una copia con valores solamente.',
      );
    if (path === 'xl/workbook.xml' && name === 'sheet') {
      metadata.sheets.push({ name: attributes.name!, relationshipId: attributes.id! });
      if (metadata.sheets.length > limits.sheets)
        throw new CatalogRuleError('El archivo admite hasta 20 hojas.');
    }
    if (path === 'xl/_rels/workbook.xml.rels' && name === 'Relationship')
      metadata.relationships[attributes.Id!] = attributes.Target!;
    if (worksheet) {
      if (name === 'row') {
        cellsInRow = 0;
        if (++rows > limits.rows + 20) tooLarge();
        const row = attributes.r === undefined ? rows : Number(attributes.r);
        if (!Number.isSafeInteger(row) || row < 1 || row > limits.rows + 20) tooLarge();
        maximumRow = Math.max(maximumRow, row);
      }
      if (name === 'c') {
        if (++cellsInRow > limits.columns) tooLarge();
        if (++cells > (limits.rows + 20) * limits.columns) tooLarge();
        if (attributes.r) checkAddress(attributes.r);
      }
      if (name === 'dimension' && attributes.ref)
        for (const address of attributes.ref.split(':')) checkAddress(address);
    }
  });
  parser.on('closeTag', () => {
    depth--;
  });
  const error = parser.parse(xml);
  if (error || depth !== 0) invalidXml();
  if (worksheet) metadata.rowCounts[path] = maximumRow;
}
