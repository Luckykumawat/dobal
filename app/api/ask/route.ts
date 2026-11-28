import { NextResponse } from 'next/server';
import { clientIp, rateLimit } from '@/lib/server';
import { STYLE_RULES, streamWithFallback } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Msg = { role: 'user' | 'assistant'; content: string };

const ALLOWED_ORIGINS = new Set([
  'https://dobal.vercel.app',
  'https://golangi.web.app',
  'https://drivepool-3s9r.onrender.com',
  'https://labelshorting.netlify.app',
  'https://dotworkspace.vercel.app',
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowed =
    ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: Request) {
  const headers = corsHeaders(req);
  const { app = 'dot-workspace', question, context = '', history = [] } = (await req.json().catch(() => ({}))) as {
    app?: string;
    question?: string;
    context?: string;
    history?: Msg[];
  };

  if (!question?.trim()) {
    return NextResponse.json({ error: 'question is required' }, { status: 400, headers });
  }
  if (question.length > 2000) {
    return NextResponse.json({ error: 'Question is too long (max 2000 characters)' }, { status: 400, headers });
  }

  const ip = clientIp(req);
  const wait =
    (await rateLimit(`ask:${ip}`, 30, 10 * 60 * 1000)) ||
    (await rateLimit(`ask-day:${ip}`, 200, 24 * 60 * 60 * 1000));
  if (wait) {
    const when = wait > 3600 ? `${Math.ceil(wait / 3600)}h` : wait > 60 ? `${Math.ceil(wait / 60)} min` : `${wait}s`;
    return NextResponse.json({ error: `Message limit reached. Please try again in ${when}.` }, { status: 429, headers });
  }

  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 1500)}`)
    .join('\n\n');

  const prompt = `You are Dobal, the built-in AI assistant across Dot Workspace apps.
The user is currently inside the "${String(app).slice(0, 50)}" app.
Be concise, practical, and directly helpful for what they are doing.
${STYLE_RULES}

APP CONTEXT:
${String(context).slice(0, 4000) || '(none)'}

${recent ? `RECENT CONVERSATION:\n${recent}\n\n` : ''}USER QUESTION:
${question.trim()}`;

  try {
    const { answer, model } = await streamWithFallback(prompt, {
      onStatus: () => {},
      onDelta: () => {},
    });
    return NextResponse.json({ answer, model }, { headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Something went wrong.';
    return NextResponse.json({ error: msg }, { status: 502, headers });
  }
}
