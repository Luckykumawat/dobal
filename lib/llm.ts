import 'server-only';
import { CHAT_MODELS, gemini, isRetryable } from '@/lib/server';

const TIMEOUT_MS = 15_000;

type Hooks = {
  /** Progress updates for the "think" step. */
  onStatus: (label: string, detail?: string) => void;
  /** Called for every streamed piece of text. */
  onDelta: (text: string) => void;
};

/**
 * Streams a Gemini answer, falling back across CHAT_MODELS when a model is busy/slow.
 * The timeout only applies until the first token arrives.
 */
export async function streamWithFallback(prompt: string, { onStatus, onDelta }: Hooks) {
  let answer = '';
  let lastErr: unknown;
  for (const model of CHAT_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      onStatus('Thinking', attempt ? `${model} · retry ${attempt}` : model);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const stream = await gemini().models.generateContentStream({
          model,
          contents: prompt,
          config: { abortSignal: controller.signal },
        });
        for await (const chunk of stream) {
          const text = chunk.text ?? '';
          if (!text) continue;
          if (!answer) {
            clearTimeout(timer);
            onStatus('Writing answer', model);
          }
          answer += text;
          onDelta(text);
        }
        return { answer, model };
      } catch (e) {
        if (answer) throw e; // already streamed part of the answer; can't switch models now
        const timedOut = controller.signal.aborted;
        lastErr = timedOut ? new Error(`timeout after ${TIMEOUT_MS / 1000}s`) : e;
        console.warn(`Model ${model} failed (attempt ${attempt + 1}):`, String((lastErr as Error).message).slice(0, 120));
        if (!timedOut && !isRetryable(e)) throw e;
        onStatus('Thinking', `${model} is ${timedOut ? 'slow' : 'busy'}, switching…`);
        if (timedOut) break;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  console.warn('All models failed:', String((lastErr as Error)?.message ?? lastErr).slice(0, 200));
  throw new Error('All Gemini models are busy right now. Please try again in a minute.');
}

export const STYLE_RULES = `Reply in the same language the user writes in (Hindi, Hinglish, English, etc.).
Write in simple, plain language with short paragraphs; use bullet lists, headings and **bold** only where they help.
If the user asks for something meant to be copied (an email, message, letter, template, quote, or code),
put ONLY that copyable part inside a fenced code block (use \`\`\`text for plain text, or the code language).`;
