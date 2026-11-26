import { NextResponse } from 'next/server';
import { extractText, getDocumentProxy } from 'unpdf';
import { chunkPages, embed, supabase } from '@/lib/server';
import { progressResponse } from '@/lib/progress';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  if (file.type !== 'application/pdf') return NextResponse.json({ error: 'Only PDF files are allowed' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'PDF must be under 10 MB' }, { status: 400 });

  return progressResponse(async ({ emit, step }) => {
    step('read', 'Reading PDF');
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    step('read', `Read ${totalPages} page${totalPages === 1 ? '' : 's'}`, 'done');

    step('split', 'Splitting text into passages');
    const chunks = chunkPages(text as string[]);
    if (!chunks.length) {
      step('split', 'No text found', 'error', 'Scanned PDFs are not supported yet');
      throw new Error('No text found (scanned PDFs are not supported yet)');
    }
    step('split', `Created ${chunks.length} passages`, 'done');

    step('embed', 'Understanding content (AI embeddings)');
    const vectors = await embed(chunks.map((c) => c.content), 'RETRIEVAL_DOCUMENT');
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
