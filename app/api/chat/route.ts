import { NextResponse } from 'next/server';
import { clientIp, embed, rateLimit, supabase } from '@/lib/server';
import { STYLE_RULES, streamWithFallback } from '@/lib/llm';
import { progressResponse } from '@/lib/progress';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Msg = { role: 'user' | 'assistant'; content: string };
type Match = { id: number; page: number; content: string; similarity: number };

const QUESTIONS_PER_10_MIN = 30;
const QUESTIONS_PER_DAY = 200;

export async function POST(req: Request) {
  const { documentId, question, history = [] } = (await req.json().catch(() => ({}))) as {
    documentId?: string;
    question?: string;
    history?: Msg[];
  };
  if (!question?.trim()) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }
  if (question.length > 4000) {
    return NextResponse.json({ error: 'Message is too long (max 4000 characters)' }, { status: 400 });
  }
  const ip = clientIp(req);
  const wait =
    (await rateLimit(`chat:${ip}`, QUESTIONS_PER_10_MIN, 10 * 60 * 1000)) ||
    (await rateLimit(`chat-day:${ip}`, QUESTIONS_PER_DAY, 24 * 60 * 60 * 1000));
  if (wait) {
    const when = wait > 3600 ? `${Math.ceil(wait / 3600)}h` : wait > 60 ? `${Math.ceil(wait / 60)} min` : `${wait}s`;
    return NextResponse.json({ error: `Message limit reached. Please try again in ${when}.` }, { status: 429 });
  }

  return progressResponse(async ({ emit, step }) => {
    const recent = history
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 3000)}`)
      .join('\n\n');
    let matches: Match[] = [];
    let prompt: string;

    if (documentId) {
      // PDFs are auto-deleted after 7 days; tell the client so it can ask for a re-upload.
      const { data: docRow, error: docErr } = await supabase().from('documents').select('id').eq('id', documentId).maybeSingle();
      if (docErr) throw docErr;
      if (!docRow) {
        emit({
          type: 'error',
          code: 'PDF_EXPIRED',
          message: 'This PDF has expired (PDFs are deleted after 7 days). Please upload it again with + to keep asking about it.',
        });
        return;
      }

      // ---- PDF mode (RAG) ----
      step('understand', 'Understanding your question');
      const [queryVec] = await embed([question], 'RETRIEVAL_QUERY', (attempt) =>
        step('understand', 'Understanding your question', 'active', `busy, retry ${attempt}`),
      );
      step('understand', 'Understood your question', 'done');

      step('search', 'Searching the document');
      const { data, error } = await supabase().rpc('match_chunks', {
        query_embedding: JSON.stringify(queryVec),
        doc_id: documentId,
        match_count: 6,
      });
      if (error) throw error;
      matches = (data ?? []) as Match[];
      const pages = [...new Set(matches.map((m) => m.page))].sort((a, b) => a - b);
      step(
        'search',
        matches.length ? `Found ${matches.length} relevant passages` : 'No closely matching passages found',
        'done',
        pages.length ? `Pages ${pages.join(', ')}` : undefined,
      );

      const context = matches.map((m, i) => `[${i + 1}] (page ${m.page})\n${m.content}`).join('\n\n');
      prompt = `You are Dobal, a helpful AI assistant. The user attached a PDF.
Answer questions about the PDF using the context below and cite pages like (p. 3).
If the question is about the PDF but the answer is not in the context, say you could not find it in the document.
If the question is general (not about the PDF), answer it normally from your own knowledge.
${STYLE_RULES}

PDF CONTEXT:
${context || '(no relevant text found)'}

CONVERSATION SO FAR:
${recent || '(none)'}

USER: ${question}`;
    } else {
      // ---- General assistant mode ----
      prompt = `You are Dobal, a friendly and knowledgeable AI assistant (like ChatGPT or Claude).
Answer any question: general knowledge, studies, coding, business, writing, advice, etc.
Be accurate and helpful. If you are not sure, say so.
${STYLE_RULES}

CONVERSATION SO FAR:
${recent || '(none)'}

USER: ${question}`;
    }

    const { answer, model } = await streamWithFallback(prompt, {
      onStatus: (label, detail) => step('think', label, 'active', detail),
      onDelta: (text) => emit({ type: 'delta', text }),
    });
    step('think', 'Thought it through', 'done', model);

    const sources = matches.map((m) => ({ page: m.page, similarity: Number(m.similarity.toFixed(3)) }));
    emit({ type: 'answer', text: answer || 'No answer was generated. Please try again.', sources, model });
  });
}
