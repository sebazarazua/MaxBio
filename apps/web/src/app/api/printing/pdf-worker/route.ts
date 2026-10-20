import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export const runtime = 'nodejs';
export async function GET() {
  // Explicit asset path: the bundler turns require.resolve(worker) into a numeric module ID.
  const worker = await readFile(
    join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  );
  return new Response(Uint8Array.from(worker), {
    headers: {
      'Content-Type': 'text/javascript',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}
