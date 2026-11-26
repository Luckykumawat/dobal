// Shared progress-event protocol (newline-delimited JSON) used by server routes and the UI.
export type StepStatus = 'active' | 'done' | 'error';
export type ProgressEvent =
  | { type: 'step'; id: string; label: string; status: StepStatus; detail?: string }
  | { type: 'delta'; text: string }
  | { type: 'answer'; text: string; sources: { page: number; similarity: number }[]; model: string }
  | { type: 'document'; document: { id: string; name: string; pages: number }; chunks: number }
  | { type: 'error'; message: string };

/** Creates an NDJSON streaming Response; `run` receives helpers to emit events. */
export function progressResponse(
  run: (h: {
    emit: (e: ProgressEvent) => void;
    step: (id: string, label: string, status?: StepStatus, detail?: string) => void;
  }) => Promise<void>,
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const emit = (e: ProgressEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      const step = (id: string, label: string, status: StepStatus = 'active', detail?: string) =>
        emit({ type: 'step', id, label, status, detail });
      try {
        await run({ emit, step });
      } catch (err) {
        console.error(err);
        emit({ type: 'error', message: err instanceof Error ? err.message : 'Something went wrong' });
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
