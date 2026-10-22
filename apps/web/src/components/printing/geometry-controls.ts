import type { PrintDefinition } from '@maxbio/contracts';

export function screenDeltaMm(deltaPx: number, screenSizePx: number, pageSizeMm: number) {
  return (deltaPx * pageSizeMm) / screenSizePx;
}
export function selectedColumn(definition: PrintDefinition, region: string) {
  const binding = /^row-\d+-(.+)$/.exec(region)?.[1];
  return definition.productRegion.columns.findIndex((column) => column.binding === binding);
}
export function moveGeometry(
  definition: PrintDefinition,
  region: string,
  dx: number,
  dy: number,
  pageWidthMm: number,
  pageHeightMm: number,
) {
  const next = structuredClone(definition);
  const box =
    next.fields.find((field) => field.id === region) ??
    (region === 'products' || selectedColumn(next, region) >= 0 ? next.productRegion : null);
  if (box) {
    const position = (value: number, limit: number) =>
      Math.max(0, Math.min(limit, Math.round(value * 10) / 10));
    box.xMm = position(box.xMm + dx, pageWidthMm - box.widthMm);
    box.yMm = position(box.yMm + dy, pageHeightMm - box.heightMm);
  }
  return next;
}

export function geometryBox(definition: PrintDefinition, region: string) {
  return definition.fields.find((f) => f.id === region) ?? definition.productRegion;
}
export function resizeProducts(
  definition: PrintDefinition,
  dx: number,
  dy: number,
  width: number,
  height: number,
) {
  const next = structuredClone(definition),
    r = next.productRegion;
  r.widthMm = Math.min(
    width - r.xMm,
    Math.max(
      r.columns.reduce((n, c) => n + c.widthMm, 0),
      Math.round((r.widthMm + dx) * 10) / 10,
    ),
  );
  r.heightMm = Math.min(
    height - r.yMm,
    Math.max(r.rowHeightMm, Math.round((r.heightMm + dy) * 10) / 10),
  );
  return next;
}
