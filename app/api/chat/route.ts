import { NextResponse } from 'next/server';
import { CHAT_MODELS, embed, gemini, isRetryable, supabase } from '@/lib/server';
import { progressResponse } from '@/lib/progress';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Msg = { role: 'user' | 'assistant'; content: string };
type Match = { id: number; page: number; content: string; similarity: number };

const TIMEOUT_MS = 15_000;

export async function POST(req: Request) {
  const { documentId, question, history = [] } = (await req.json().catch(() => ({}))) as {
    documentId?: string;
    question?: string;
    history?: Msg[];
  };
  if (!documentId || !question?.trim()) {
    return NextResponse.json({ error: 'documentId and question are required' }, { status: 400 });
  }

  return progressResponse(async ({ emit, step }) => {
    // 1. Understand the question
    step('understand', 'Understanding your question');
    const [queryVec] = await embed([question], 'RETRIEVAL_QUERY');
    step('understand', 'Understood your question', 'done');

    // 2. Search the PDF
    step('search', 'Searching the document');
    const { data, error } = await supabase().rpc('match_chunks', {
      query_embedding: JSON.stringify(queryVec),
      doc_id: documentId,
      match_count: 6,
    });
    if (error) throw error;
    const matches = (data ?? []) as Match[];
    const pages = [...new Set(matches.map((m) => m.page))].sort((a, b) => a - b);
    step(
      'search',
      matches.length ? `Found ${matches.length} relevant passages` : 'No closely matching passages found',
      'done',
      pages.length ? `Pages ${pages.join(', ')}` : undefined,
    );

    // 3. Ask the model (with fallback across models)
    const context = matches.map((m, i) => `[${i + 1}] (page ${m.page})\n${m.content}`).join('\n\n');
    const recent = history.slice(-6).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
    const prompt = `You answer questions about a PDF using ONLY the context below.
If the answer is not in the context, say you could not find it in the document.
Cite pages like (p. 3). Reply in the same language as the question.

CONTEXT:
${context || '(no relevant text found)'}

CONVERSATION SO FAR:
${recent || '(none)'}

QUESTION: ${question}`;

    let answer = '';
    let usedModel = '';
    let lastErr: unknown;
    outer: for (const model of CHAT_MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        step('think', 'Thinking', 'active', attempt ? `${model} · retry ${attempt}` : model);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await gemini().models.generateContent({
            model,
            contents: prompt,
            config: { abortSignal: controller.signal },
          });
          answer = res.text ?? '';
          usedModel = model;
          break outer;
        } catch (e) {
          const timedOut = controller.signal.aborted;
          lastErr = timedOut ? new Error(`timeout after ${TIMEOUT_MS / 1000}s`) : e;
          console.warn(`Model ${model} failed (attempt ${attempt + 1}):`, String((lastErr as Error).message).slice(0, 120));
          if (!timedOut && !isRetryable(e)) throw e;
          step('think', 'Thinking', 'active', `${model} is ${timedOut ? 'slow' : 'busy'}, switching…`);
          if (timedOut) break;
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
    }
    if (!usedModel) {
      step('think', 'All models are busy', 'error', String((lastErr as Error)?.message ?? '').slice(0, 120));
      throw new Error('All Gemini models are busy right now. Please try again in a minute.');
    }
    step('think', 'Thought it through', 'done', usedModel);
    console.log(`Answered with ${usedModel}`);

    // 4. Finalize
    step('finalize', 'Finalizing answer');
    const sources = matches.map((m) => ({ page: m.page, similarity: Number(m.similarity.toFixed(3)) }));
    step('finalize', 'Answer ready', 'done');
    emit({ type: 'answer', text: answer || 'No answer was generated. Please rephrase your question.', sources, model: usedModel });
  });
}
