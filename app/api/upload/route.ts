import { NextResponse } from 'next/server';
import { extractText, getDocumentProxy } from 'unpdf';
import { chunkPages, clientIp, embed, rateLimit, supabase } from '@/lib/server';
import { progressResponse } from '@/lib/progress';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Vercel rejects request bodies above ~4.5 MB, so stay safely below it.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 50;
const UPLOADS_PER_HOUR = 5;

export async function POST(req: Request) {
  const wait = rateLimit(`upload:${clientIp(req)}`, UPLOADS_PER_HOUR, 60 * 60 * 1000);
  if (wait) {
    return NextResponse.json(
      { error: `Upload limit reached (${UPLOADS_PER_HOUR}/hour). Try again in ${Math.ceil(wait / 60)} min.` },
      { status: 429 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  // Some browsers/OSes send an empty or generic MIME type, so also accept the .pdf extension.
  const looksPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!looksPdf) return NextResponse.json({ error: 'Only PDF files are allowed' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'PDF must be under 4 MB' }, { status: 400 });

  return progressResponse(async ({ emit, step }) => {
    step('read', 'Reading PDF');
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Real check: PDF files start with "%PDF"
    if (String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') throw new Error('This file is not a valid PDF');
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    if (totalPages > MAX_PAGES) {
      step('read', `PDF has ${totalPages} pages`, 'error', `Max ${MAX_PAGES} pages`);
      throw new Error(`PDF has ${totalPages} pages. Please upload a PDF with at most ${MAX_PAGES} pages.`);
    }
    step('read', `Read ${totalPages} page${totalPages === 1 ? '' : 's'}`, 'done');

    step('split', 'Splitting text into passages');
    const chunks = chunkPages(text as string[]);
    if (!chunks.length) {
      step('split', 'No text found', 'error', 'Scanned PDFs are not supported yet');
      throw new Error('No text found (scanned PDFs are not supported yet)');
    }
    step('split', `Created ${chunks.length} passages`, 'done');

    step('embed', 'Understanding content (AI embeddings)');
    const vectors = await embed(chunks.map((c) => c.content), 'RETRIEVAL_DOCUMENT', (attempt, ms) =>
      step('embed', 'Understanding content (AI embeddings)', 'active', `rate limited, retry ${attempt} in ${Math.round(ms / 1000)}s`),
    );
    step('embed', 'Content understood', 'done');

    step('save', 'Saving to database');
    const db = supabase();
    const { data: doc, error: docErr } = await db
      .from('documents')
      .insert({ name: file.name, pages: totalPages })
      .select('id, name, pages')
      .single();
    if (docErr) throw docErr;
    const rows = chunks.map((c, i) => ({
      document_id: doc.id,
      page: c.page,
      content: c.content,
      embedding: JSON.stringify(vectors[i]),
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from('chunks').insert(rows.slice(i, i + 200));
      if (error) {
        await db.from('documents').delete().eq('id', doc.id);
        throw error;
      }
    }
    step('save', 'Ready to chat', 'done');
    emit({ type: 'document', document: doc, chunks: rows.length });
  });
}
