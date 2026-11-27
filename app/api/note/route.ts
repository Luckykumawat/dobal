import { NextResponse } from 'next/server';
import { clientIp, rateLimit } from '@/lib/server';
import { STYLE_RULES, streamWithFallback } from '@/lib/llm';
import { progressResponse } from '@/lib/progress';

export const runtime = 'nodejs';
export const maxDuration = 60;

const NOTES_PER_10_MIN = 30;

/** Explains a piece of text the user selected from an answer, for saving in Notes. */
export async function POST(req: Request) {
  const { text, question, context } = (await req.json().catch(() => ({}))) as {
    text?: string;
    question?: string;
    context?: string;
  };
  if (!text?.trim()) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: 'Selection is too long (max 2000 characters)' }, { status: 400 });

  const wait = await rateLimit(`note:${clientIp(req)}`, NOTES_PER_10_MIN, 10 * 60 * 1000);
  if (wait) return NextResponse.json({ error: `Too many notes. Please wait ${wait}s and try again.` }, { status: 429 });

  return progressResponse(async ({ emit, step }) => {
    const prompt = `You are Dobal, an AI tutor. The user is reading an answer and selected a word or sentence
they want to save in their personal study notes. Write a clear note explaining the SELECTED TEXT.

- Start directly with the explanation (no greeting, no "Sure").
- Explain what it means in simple words, then why it matters, and give a short example if helpful.
- Keep it concise (about 80-200 words) unless the user's request asks for more.
- Use the surrounding context only to understand the meaning; focus on the selected text.
- If the user gave a specific request, answer exactly that.
${STYLE_RULES}

SURROUNDING CONTEXT (the answer the text was selected from):
${(context ?? '').slice(0, 4000) || '(none)'}

SELECTED TEXT:
"${text.trim()}"

USER'S REQUEST: ${question?.trim() || 'Explain this in simple words.'}`;

    const { answer, model } = await streamWithFallback(prompt, {
      onStatus: (label, detail) => step('think', label, 'active', detail),
      onDelta: (t) => emit({ type: 'delta', text: t }),
    });
    step('think', 'Note ready', 'done', model);
    emit({ type: 'answer', text: answer || 'Could not generate an explanation. Please try again.', sources: [], model });
  });
}
