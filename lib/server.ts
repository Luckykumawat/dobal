import 'server-only';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const EMBED_DIM = 768;
// First model from env, then fallbacks (tried in order when a model is busy/unavailable).
export const CHAT_MODELS = [
  ...new Set(
    [
      process.env.GEMINI_CHAT_MODEL,
      'gemini-3.5-flash-lite', // fastest, used first if the main model is slow/busy
      'gemini-3.5-flash',
      'gemini-flash-lite-latest',
      'gemini-flash-latest',
    ].filter((m): m is string => Boolean(m)),
  ),
];

/** Retry-worthy errors: overloaded (503), rate limit (429), model removed (404). */
export function isRetryable(err: unknown) {
  const text = String((err as { status?: number })?.status ?? '') + ' ' + String((err as Error)?.message ?? err);
  return /\b(503|429|404|500)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND|overloaded|high demand/i.test(text);
}
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';

let ai: GoogleGenAI | null = null;
export function gemini() {
  ai ??= new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
  return ai;
}

export function supabase() {
  return createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries `fn` on 429/503-style errors with exponential backoff (1s, 2s, 4s, 8s...). */
export async function withRetry<T>(fn: () => Promise<T>, onRetry?: (attempt: number, waitMs: number) => void, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !isRetryable(e)) throw e;
      const waitMs = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300);
      onRetry?.(attempt, waitMs);
      await sleep(waitMs);
    }
  }
}

// ---- Simple in-memory rate limiter (per server instance; good enough for a demo app) ----
const hits = new Map<string, number[]>();
/** Returns seconds to wait if `key` exceeded `limit` requests in `windowMs`, else 0. */
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) return Math.ceil((recent[0] + windowMs - now) / 1000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear(); // avoid unbounded memory
  return 0;
}
export function clientIp(req: Request) {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
}

export async function embed(
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  onRetry?: (attempt: number, waitMs: number) => void,
) {
  const out: number[][] = [];
  // Batch to stay within API limits
  for (let i = 0; i < texts.length; i += 50) {
    const res = await withRetry(
      () =>
        gemini().models.embedContent({
          model: EMBED_MODEL,
          contents: texts.slice(i, i + 50),
          config: { taskType, outputDimensionality: EMBED_DIM },
        }),
      onRetry,
    );
    for (const e of res.embeddings ?? []) out.push(e.values ?? []);
  }
  return out;
}

/** Split page text into overlapping chunks (~1000 chars). */
export function chunkPages(pages: string[], size = 1000, overlap = 200) {
  const chunks: { page: number; content: string }[] = [];
  pages.forEach((raw, idx) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    for (let start = 0; start < text.length; start += size - overlap) {
      const content = text.slice(start, start + size).trim();
      if (content.length > 30) chunks.push({ page: idx + 1, content });
      if (start + size >= text.length) break;
    }
  });
  return chunks;
}
