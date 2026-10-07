import type {
  CatalogColumnMapping,
  CatalogCommercialOptions,
  CatalogSheetInspection,
} from '@maxbio/contracts';

// Neutral extraction boundary. Values are text lexemes, never executable content.
export interface IntermediateTable {
  name: string;
  rows: string[][];
  cellStates?: Record<string, 'STORED_RESULT' | 'UNAVAILABLE'>;
  // Numeric lexemes use decimal dots. Percentage cells contain fractions (0.21 = 21%).
  numericCells?: string[];
  percentageCells?: string[];
  warnings?: string[];
}
export interface WorkbookInspection {
  tables: IntermediateTable[];
  warnings: string[];
}
export interface SupplierCatalogExtractor {
  extract(buffer: Buffer): Promise<WorkbookInspection>;
}
export interface UnknownFormatAnalyzer {
  analyze(table: IntermediateTable): Promise<CatalogSheetInspection>;
}
export interface CatalogImportProfile {
  fingerprint: string;
  sheetName: string;
  headerRow: number;
  headers: string[];
  mapping: CatalogColumnMapping;
  commercial: CatalogCommercialOptions;
}
export const cellKey = (row: number, column: number) => `${row}:${column}`;
