import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import readExcelFile from 'read-excel-file/node';
import { fromBuffer, type Entry } from 'yauzl';
import { posix } from 'node:path';
import { supplierCatalogLimits as limits } from '@maxbio/contracts';
import type { CatalogSheet } from './catalog-import.js';
import type { SupplierCatalogExtractor } from './catalog-table.js';
import { CatalogRuleError } from './identifiers.js';
import { validateXlsxXml, type XlsxXmlMetadata } from './catalog-xlsx-xml.js';

const unreadableExcel =
  'No pudimos leer este archivo de Excel. Verificá que sea un archivo .xlsx válido.';
const hasControl = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export function safeFileName(name: string) {
  const base = name.replace(/\\/g, '/').split('/').at(-1) ?? '';
  return (
    Array.from(base)
      .filter((char) => !hasControl(char))
      .join('')
      .slice(0, 200) || 'lista'
  );
}
function validateSheets(sheets: CatalogSheet[]) {
  if (!sheets.length || sheets.length > limits.sheets)
    throw new CatalogRuleError('El archivo admite entre 1 y 20 hojas.');
  const names = new Set<string>();
  let characters = 0;
  for (const sheet of sheets) {
    if (
      !sheet.name ||
      sheet.name.length > 31 ||
      hasControl(sheet.name) ||
      Array.from(sheet.name).some((char) => '\\/[]:*?'.includes(char)) ||
      names.has(sheet.name)
    )
      throw new CatalogRuleError('Revisá los nombres de las hojas (únicos, hasta 31 caracteres).');
    names.add(sheet.name);
    if (sheet.rows.length > limits.rows + 20)
      throw new CatalogRuleError('El archivo admite hasta 10.000 filas de artículos por hoja.');
    for (const row of sheet.rows) {
      if (row.length > limits.columns)
        throw new CatalogRuleError('El archivo admite hasta 100 columnas por hoja.');
      for (const cell of row) {
        if (cell.length > limits.cellCharacters)
          throw new CatalogRuleError(
            'Una celda supera los 4.000 caracteres. Corregila en el archivo.',
          );
        characters += cell.length;
        if (characters > 10 * 1024 * 1024)
          throw new CatalogRuleError(
            'El contenido de las celdas es demasiado grande. Dividí el archivo.',
          );
      }
    }
  }
}
// Preflight secuencial: no confiar en tamaños declarados ni expandir un ZIP completo primero.
export function validateXlsxArchive(buffer: Buffer): Promise<XlsxXmlMetadata> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new CatalogRuleError(unreadableExcel));
          return;
        }
        let total = 0;
        let entries = 0;
        let done = false;
        const names = new Set<string>();
        const metadata: XlsxXmlMetadata = {
          sheets: [],
          relationships: {},
          rowCounts: {},
          cellStates: {},
          numericCells: {},
          percentageStyles: [],
          warnings: [],
        };
        const fail = (cause: unknown) => {
          if (done) return;
          done = true;
          zip.close();
          reject(cause instanceof CatalogRuleError ? cause : new CatalogRuleError(unreadableExcel));
        };
        zip.on('error', fail);
        zip.on('end', () => {
          if (done) return;
          if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
            fail(new CatalogRuleError(unreadableExcel));
            return;
          }
          done = true;
          resolve(metadata);
        });
        zip.on('entry', (entry: Entry) => {
          if (done) return;
          if (
            ++entries > 1000 ||
            names.has(entry.fileName) ||
            entry.isEncrypted() ||
            entry.uncompressedSize > limits.expandedBytes ||
            total + entry.uncompressedSize > limits.expandedBytes
          ) {
            fail(
              new CatalogRuleError(
                'El Excel tiene contenido comprimido excesivo, duplicado o protegido. Usá una lista simple.',
              ),
            );
            return;
          }
          names.add(entry.fileName);
          if (/vba|embeddings|\.bin$/i.test(entry.fileName)) {
            fail(
              new CatalogRuleError(
                'No se admiten macros ni archivos incrustados. Usá una lista .xlsx sin macros.',
              ),
            );
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
              fail(error);
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            const xml = /\.(?:xml|rels)$/i.test(entry.fileName);
            stream.on('error', fail);
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length;
              total += chunk.length;
              if (total > limits.expandedBytes || size > 20 * 1024 * 1024) {
                stream.destroy();
                fail(
                  new CatalogRuleError(
                    'El Excel supera el límite de expansión permitido (40 MiB).',
                  ),
                );
                return;
              }
              if (xml) chunks.push(chunk);
            });
            stream.on('end', () => {
              if (done) return;
              if (xml) {
                const data = Buffer.concat(chunks).toString('utf8');
                try {
                  if (data.includes('\u0000')) throw new CatalogRuleError(unreadableExcel);
                  validateXlsxXml(data, entry.fileName, metadata);
                } catch (error) {
                  fail(error);
                  return;
                }
              }
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
export async function parseCatalogFile(buffer: Buffer, originalName: string, mime: string) {
  if (!buffer.length || buffer.length > limits.fileBytes)
    throw new CatalogRuleError('Elegí un archivo de hasta 10 MiB.');
  const fileName = safeFileName(originalName);
  const extension = fileName.toLowerCase().split('.').at(-1);
  if (extension !== 'csv' && extension !== 'xlsx')
    throw new CatalogRuleError('Elegí un archivo .csv o .xlsx. No se admite .xls.');
  const allowedMime =
    extension === 'xlsx'
      ? [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/octet-stream',
          'application/zip',
        ]
      : [
          'text/csv',
          'application/csv',
          'text/plain',
          'application/vnd.ms-excel',
          'application/octet-stream',
        ];
  if (mime && !allowedMime.includes(mime.toLowerCase()))
    throw new CatalogRuleError('El tipo de archivo no corresponde a CSV o XLSX.');
  let sheets: CatalogSheet[];
  if (extension === 'csv') {
    try {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (source.includes('\u0000')) throw new Error();
      const outsideQuotes = source
        .split(/\r?\n/)
        .slice(0, 40)
        .map((line) => line.replace(/"(?:[^"]|"")*"/g, ''))
        .join('\n');
      const delimiter = [',', ';', '\t'].sort(
        (a, b) => outsideQuotes.split(b).length - outsideQuotes.split(a).length,
      )[0]!;
      let records = 0;
      const rows = parse(source, {
        delimiter,
        bom: true,
        cast: false,
        relax_column_count: true,
        skip_empty_lines: false,
        max_record_size: 400000,
        on_record: (row: string[]) => {
          if (
            ++records > limits.rows + 20 ||
            row.length > limits.columns ||
            row.some((cell) => cell.length > limits.cellCharacters)
          )
            throw new CatalogRuleError(
              'El CSV supera 10.000 filas, 100 columnas o 4.000 caracteres por celda.',
            );
          return row;
        },
      }) as string[][];
      sheets = [{ name: 'CSV', rows }];
    } catch (error) {
      if (error instanceof CatalogRuleError) throw error;
      throw new CatalogRuleError(
        'No pudimos leer el CSV. Usá UTF-8, comas, punto y coma o tabulaciones, y revisá las comillas.',
      );
    }
  } else {
    if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
      throw new CatalogRuleError(unreadableExcel);
    const metadata = await validateXlsxArchive(buffer);
    try {
      const workbook = await readExcelFile(buffer, { trim: false, parseNumber: (value) => value });
      sheets = workbook.map((sheet) => ({
        name: sheet.sheet,
        rows: sheet.data.map((row) =>
          row.map((cell) =>
            cell === null ? '' : cell instanceof Date ? cell.toISOString() : String(cell),
          ),
        ),
      }));
      for (const sheet of sheets) {
        const descriptor = metadata.sheets.find((item) => item.name === sheet.name);
        const target = descriptor ? metadata.relationships[descriptor.relationshipId] : undefined;
        const path = target
          ? posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target)
          : '';
        const rowCount = metadata.rowCounts[path] ?? sheet.rows.length;
        sheet.cellStates = metadata.cellStates[path] ?? {};
        sheet.numericCells = (metadata.numericCells[path] ?? []).map((cell) => cell.key);
        sheet.percentageCells = (metadata.numericCells[path] ?? [])
          .filter(
            (cell) =>
              cell.style !== undefined && metadata.percentageStyles.includes(Number(cell.style)),
          )
          .map((cell) => cell.key);
        sheet.warnings = [...metadata.warnings];
        if (Object.keys(sheet.cellStates).length)
          sheet.warnings.push(
            'Hay celdas calculadas. Solo leemos resultados guardados; pueden estar desactualizados. Los datos sin resultado disponible requieren revisión.',
          );
        for (const [key, state] of Object.entries(sheet.cellStates)) {
          const [row, column] = key.split(':').map(Number);
          if (state === 'STORED_RESULT' && !sheet.rows[row! - 1]?.[column!]?.trim())
            sheet.cellStates[key] = 'UNAVAILABLE';
        }
        // El lector recorta vacías finales; preservarlas para contabilizar y conservar números reales.
        while (sheet.rows.length < rowCount) sheet.rows.push([]);
      }
    } catch {
      throw new CatalogRuleError(unreadableExcel);
    }
  }
  validateSheets(sheets);
  return {
    fileName,
    format: extension === 'csv' ? ('CSV' as const) : ('XLSX' as const),
    contentHash: createHash('sha256').update(buffer).digest('hex'),
    sheets,
    warnings: [...new Set(sheets.flatMap((sheet) => sheet.warnings ?? []))],
  };
}

// The dispatch owns file metadata; each adapter implements the same neutral boundary.
export class CsvSupplierCatalogExtractor implements SupplierCatalogExtractor {
  async extract(buffer: Buffer) {
    const parsed = await parseCatalogFile(buffer, 'lista.csv', 'text/csv');
    return { tables: parsed.sheets, warnings: parsed.warnings };
  }
}
export class XlsxSupplierCatalogExtractor implements SupplierCatalogExtractor {
  async extract(buffer: Buffer) {
    const parsed = await parseCatalogFile(buffer, 'lista.xlsx', 'application/octet-stream');
    return { tables: parsed.sheets, warnings: parsed.warnings };
  }
}
