import { Parser } from 'saxen';
import { posix } from 'node:path';
import { supplierCatalogLimits as limits } from '@maxbio/contracts';
import { CatalogRuleError } from './identifiers.js';

export interface XlsxXmlMetadata {
  sheets: { name: string; relationshipId: string }[];
  relationships: Record<string, string>;
  rowCounts: Record<string, number>;
  cellStates: Record<string, Record<string, 'STORED_RESULT' | 'UNAVAILABLE'>>;
  numericCells: Record<string, { key: string; style: string | undefined }[]>;
  percentageStyles: number[];
  warnings: string[];
}
const localName = (name: string) => name.split(':').at(-1)!;
export function validateXlsxXml(xml: string, path: string, metadata: XlsxXmlMetadata) {
  const parser = new Parser();
  let worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(path);
  let depth = 0;
  let nodes = 0;
  let rows = 0;
  let cells = 0;
  let cellsInRow = 0;
  let maximumRow = 0;
  let cell: { key: string; type: string; style: string | undefined } | null = null;
  let formula = false;
  let value = '';
  let inValue = false;
  let rowNumber = 0;
  let formulaCoverage = 0;
  let inCellXfs = false;
  let styleIndex = 0;
  const percentageFormats = new Set(['9', '10']);
  const states: Record<string, 'STORED_RESULT' | 'UNAVAILABLE'> = {};
  const numerics: { key: string; style: string | undefined }[] = [];
  const warnExternal = () => {
    if (!metadata.warnings.length)
      metadata.warnings.push(
        'La lista contiene vínculos externos. No se abrieron ni actualizaron; revisá los valores guardados.',
      );
  };
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
    return { row, column };
  };
  const invalidXml = () => {
    throw new CatalogRuleError(
      'No pudimos leer la estructura de este Excel. Guardá una copia .xlsx nueva.',
    );
  };
  parser
    .on('error', invalidXml)
    .on('warn', invalidXml)
    .on('attention', () => {
      throw new CatalogRuleError(
        'El Excel contiene declaraciones no seguras. Usá una lista simple.',
      );
    });
  parser.on('openTag', (rawName, getAttributes, decode) => {
    const name = localName(rawName);
    if (depth === 0 && name === 'worksheet') worksheet = true;
    const attributes = Object.fromEntries(
      Object.entries(getAttributes()).map(([key, value]) => [localName(key), decode(value)]),
    );
    if (++depth > 64 || ++nodes > 2000000)
      throw new CatalogRuleError(
        'El Excel tiene una estructura demasiado compleja. Usá una lista simple.',
      );
    if (Object.values(attributes).some((value) => /macroEnabled|vbaProject/i.test(value)))
      throw new CatalogRuleError('Este Excel contiene macros. Usá una lista .xlsx sin macros.');
    if (
      name === 'hyperlink' ||
      attributes.TargetMode?.toLowerCase() === 'external' ||
      /externalLinks/i.test(path)
    )
      warnExternal();
    if (path === 'xl/workbook.xml' && name === 'sheet') {
      metadata.sheets.push({ name: attributes.name!, relationshipId: attributes.id! });
      if (metadata.sheets.length > limits.sheets)
        throw new CatalogRuleError('El archivo admite hasta 20 hojas.');
    }
    if (name === 'Relationship' && attributes.TargetMode?.toLowerCase() !== 'external') {
      const target = attributes.Target ?? '';
      const resolved = posix.normalize(
        target.startsWith('/') ? target.slice(1) : path.replace(/_rels\/[^/]+\.rels$/, '') + target,
      );
      if (
        /^[a-z]+:/i.test(target) ||
        target.includes('\\') ||
        resolved.startsWith('../') ||
        resolved === '..'
      )
        throw new CatalogRuleError(
          'El Excel contiene vínculos internos inválidos. Usá una lista simple.',
        );
      if (path === 'xl/_rels/workbook.xml.rels') metadata.relationships[attributes.Id!] = target;
    }
    if (path === 'xl/styles.xml') {
      if (name === 'numFmt' && /%/.test((attributes.formatCode ?? '').replace(/"[^"]*"|\\./g, '')))
        percentageFormats.add(attributes.numFmtId!);
      if (name === 'cellXfs') inCellXfs = true;
      if (name === 'xf' && inCellXfs) {
        if (percentageFormats.has(attributes.numFmtId!)) metadata.percentageStyles.push(styleIndex);
        styleIndex++;
      }
    }
    if (worksheet) {
      if (name === 'row') {
        cellsInRow = 0;
        if (++rows > limits.rows + 20) tooLarge();
        const row = attributes.r === undefined ? rows : Number(attributes.r);
        if (!Number.isSafeInteger(row) || row < 1 || row > limits.rows + 20) tooLarge();
        maximumRow = Math.max(maximumRow, row);
        rowNumber = row;
      }
      if (name === 'c') {
        if (++cellsInRow > limits.columns) tooLarge();
        if (++cells > (limits.rows + 20) * limits.columns) tooLarge();
        const address = attributes.r
          ? checkAddress(attributes.r)
          : { row: rowNumber, column: cellsInRow };
        cell = {
          key: `${address.row}:${address.column - 1}`,
          type: attributes.t ?? 'n',
          style: attributes.s,
        };
        formula = false;
        value = '';
        if (cell.type === 'n') numerics.push({ key: cell.key, style: cell.style });
      }
      if (name === 'f') {
        if (!cell) invalidXml();
        formula = true;
        if (attributes.ref) {
          const [start, end = start] = attributes.ref.split(':');
          const from = checkAddress(start!);
          const to = checkAddress(end!);
          const area = (to.row - from.row + 1) * (to.column - from.column + 1);
          if (
            area < 1 ||
            to.row < from.row ||
            to.column < from.column ||
            (formulaCoverage += area) > (limits.rows + 20) * limits.columns
          )
            tooLarge();
          for (let r = from.row; r <= to.row; r++)
            for (let c = from.column; c <= to.column; c++)
              states[`${r}:${c - 1}`] = 'STORED_RESULT';
        }
      }
      if (name === 'v') inValue = true;
      if (name === 'dimension' && attributes.ref)
        for (const address of attributes.ref.split(':')) checkAddress(address);
    }
  });
  parser.on('text', (text, decode) => {
    if (inValue) value += decode(text);
  });
  parser.on('closeTag', (rawName) => {
    const name = localName(rawName);
    if (name === 'cellXfs') inCellXfs = false;
    if (name === 'v') inValue = false;
    if (name === 'c' && cell) {
      if (formula || cell.type === 'e')
        states[cell.key] = value.trim() && cell.type !== 'e' ? 'STORED_RESULT' : 'UNAVAILABLE';
      cell = null;
    }
    depth--;
  });
  const error = parser.parse(xml);
  if (error || depth !== 0) invalidXml();
  if (worksheet) {
    metadata.rowCounts[path] = maximumRow;
    metadata.cellStates[path] = states;
    metadata.numericCells[path] = numerics;
  }
}
