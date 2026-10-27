import { traceabilitySourceSchema } from '@maxbio/contracts';

// Filter state mirrored in /trazabilidad query params: ids, dates, origin and the search
// text the user typed. Never raw GS1 readings, patient data or the selected detail.
export type TraceabilityParams = {
  search: string;
  productId: string;
  customerId: string;
  source: '' | 'STOCK' | 'DOCUMENTARY';
  dateFrom: string;
  dateTo: string;
  page: number;
};
export const emptyTraceabilityParams: TraceabilityParams = {
  search: '',
  productId: '',
  customerId: '',
  source: '',
  dateFrom: '',
  dateTo: '',
  page: 1,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const date = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

// Unknown or malformed values are dropped, so an edited URL never breaks the screen.
export function traceabilityParams(
  query: Record<string, string | string[] | undefined>,
): TraceabilityParams {
  const value = (key: string) => {
    const v = query[key];
    return typeof v === 'string' ? v : '';
  };
  const source = traceabilitySourceSchema.safeParse(value('source'));
  const page = Number(value('page'));
  const dateFrom = date.test(value('dateFrom')) ? value('dateFrom') : '';
  const dateTo = date.test(value('dateTo')) ? value('dateTo') : '';
  return {
    search: value('search').trim().slice(0, 128),
    productId: uuid.test(value('productId')) ? value('productId') : '',
    customerId: uuid.test(value('customerId')) ? value('customerId') : '',
    source: source.success ? source.data : '',
    dateFrom,
    dateTo: dateFrom && dateTo && dateTo < dateFrom ? '' : dateTo,
    page: Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1,
  };
}

export function traceabilityQuery(params: TraceabilityParams) {
  const query = new URLSearchParams();
  for (const key of ['search', 'productId', 'customerId', 'source', 'dateFrom', 'dateTo'] as const)
    if (params[key]) query.set(key, params[key]);
  if (params.page > 1) query.set('page', String(params.page));
  return query.toString();
}

export const hasTraceabilityCriteria = (params: TraceabilityParams) =>
  Boolean(traceabilityQuery({ ...params, page: 1 }));

// YYYY-MM-DD business dates shown as DD/MM/YYYY.
export const displayDate = (iso: string) => iso.split('-').reverse().join('/');
