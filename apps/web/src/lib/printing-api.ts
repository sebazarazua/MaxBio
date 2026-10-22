import { apiErrorSchema } from '@maxbio/contracts';
export class PrintRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function printingRequest(path: string, body?: unknown, signal?: AbortSignal) {
  const r = await fetch('/api/printing/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Maxbio-Csrf': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) {
    const error = apiErrorSchema.safeParse(await r.json());
    throw new PrintRequestError(
      error.success ? error.data.message : 'No pudimos procesar la impresión.',
      r.status,
    );
  }
  return r;
}
export async function printingJson<T>(
  path: string,
  schema: { parse(input: unknown): T },
  body?: unknown,
  signal?: AbortSignal,
) {
  return schema.parse(await (await printingRequest(path, body, signal)).json());
}
export async function printingPdf(path: string, body?: unknown, signal?: AbortSignal) {
  const r = await printingRequest(path, body, signal);
  if (!r.headers.get('content-type')?.startsWith('application/pdf'))
    throw new Error('No recibimos un PDF válido.');
  return new Uint8Array(await r.arrayBuffer());
}
export function downloadPrintPdf(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'maxbio.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
