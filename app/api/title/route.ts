import { NextResponse } from 'next/server';
import { clientIp, rateLimit } from '@/lib/server';
import { streamWithFallback } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Generates a short chat title (like ChatGPT's sidebar titles) from the first exchange. */
export async function POST(req: Request) {
  const { question, answer } = (await req.json().catch(() => ({}))) as { question?: string; answer?: string };
  if (!question?.trim()) return NextResponse.json({ error: 'question is required' }, { status: 400 });
  if (await rateLimit(`title:${clientIp(req)}`, 60, 10 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const prompt = `Write a short title (2 to 6 words) for this chat, like the titles in ChatGPT's sidebar.
Use the same language as the user's message. No quotes, no emojis, no ending punctuation. Reply with ONLY the title.

USER: ${question.slice(0, 1500)}
ASSISTANT: ${(answer ?? '').slice(0, 1500)}`;

  try {
    const { answer: raw } = await streamWithFallback(prompt, { onStatus: () => {}, onDelta: () => {} });
    const title = raw.split('\n')[0].replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, '').slice(0, 60);
    return NextResponse.json({ title: title || question.slice(0, 40) });
  } catch {
    return NextResponse.json({ title: question.slice(0, 40) });
  }
}
