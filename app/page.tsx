'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import type { ProgressEvent, StepStatus } from '@/lib/progress';

type Step = { id: string; label: string; status: StepStatus; detail?: string; startedAt: number; endedAt?: number };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  steps?: Step[];
  sources?: { page: number }[];
  model?: string;
  pending?: boolean;
};
type Doc = { id: string; name: string; pages: number };

/** Reads an NDJSON progress stream, calling onEvent for every event. */
async function readProgress(res: Response, onEvent: (e: ProgressEvent) => void) {
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

function applyStep(steps: Step[], e: Extract<ProgressEvent, { type: 'step' }>): Step[] {
  const now = Date.now();
  const existing = steps.find((s) => s.id === e.id);
  if (!existing) return [...steps, { ...e, startedAt: now, endedAt: e.status === 'active' ? undefined : now }];
  return steps.map((s) =>
    s.id === e.id ? { ...s, ...e, endedAt: e.status === 'active' ? undefined : now } : s,
  );
}

function useTicker(active: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [active]);
}

function StepList({ steps, live }: { steps: Step[]; live: boolean }) {
  useTicker(live);
  return (
    <ul className="steps" aria-live="polite">
      {steps.map((s) => {
        const secs = (((s.endedAt ?? Date.now()) - s.startedAt) / 1000).toFixed(1);
        return (
          <li key={s.id} className={`step ${s.status}`}>
            <span className="icon">{s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : <span className="spinner" />}</span>
            <span className={`label ${s.status === 'active' ? 'shimmer' : ''}`}>{s.label}</span>
            {s.detail && <span className="detail">· {s.detail}</span>}
            <span className="time">{secs}s</span>
          </li>
        );
      })}
    </ul>
  );
}

function Activity({ steps, pending }: { steps: Step[]; pending?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  if (pending) return <StepList steps={steps} live />;
  const total = ((Math.max(...steps.map((s) => s.endedAt ?? s.startedAt)) - steps[0].startedAt) / 1000).toFixed(1);
  return (
    <div className="activity">
      <button type="button" className="activity-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Worked for {total}s · {steps.length} steps
      </button>
      {open && <StepList steps={steps} live={false} />}
    </div>
  );
}

export default function Home() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [uploadSteps, setUploadSteps] = useState<Step[]>([]);
  const [uploading, setUploading] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function upload(file: File) {
    setError('');
    setUploading(true);
    setUploadSteps([]);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      await readProgress(res, (e) => {
        if (e.type === 'step') setUploadSteps((s) => applyStep(s, e));
        if (e.type === 'document') {
          setDoc(e.document);
          setMessages([]);
        }
        if (e.type === 'error') throw new Error(e.message);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function updateLast(fn: (m: Msg) => Msg) {
    setMessages((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!doc || !question || busy) return;
    setInput('');
    setError('');
    setBusy(true);
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [
      ...m,
      { role: 'user', content: question },
      { role: 'assistant', content: '', steps: [], pending: true },
    ]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc.id, question, history }),
      });
      await readProgress(res, (ev) => {
        if (ev.type === 'step') updateLast((m) => ({ ...m, steps: applyStep(m.steps ?? [], ev) }));
        if (ev.type === 'answer')
          updateLast((m) => ({ ...m, content: ev.text, sources: ev.sources, model: ev.model, pending: false }));
        if (ev.type === 'error') throw new Error(ev.message);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat failed';
      updateLast((m) => ({ ...m, pending: false, content: `⚠️ ${message}` }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <header>
        <h1>📄 AI PDF Chat</h1>
        <p className="muted">Upload a PDF and ask anything about it.</p>
      </header>

      <label className={`drop ${uploading ? 'disabled' : ''}`}>
        <input
          type="file"
          accept="application/pdf"
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) upload(f);
          }}
        />
        {uploading ? 'Processing PDF…' : doc ? `✅ ${doc.name} (${doc.pages} pages) · click to change` : 'Click to upload a PDF (max 10 MB)'}
      </label>
      {uploadSteps.length > 0 && (uploading ? <StepList steps={uploadSteps} live /> : <Activity steps={uploadSteps} />)}

      {error && <p className="error" role="alert">{error}</p>}

      <section className="chat">
        {messages.length === 0 && doc && <p className="muted">Ask a question, e.g. “Summarize this document”.</p>}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' && m.steps && <Activity steps={m.steps} pending={m.pending} />}
            {(m.role === 'user' || m.content) && <div className="bubble">{m.content}</div>}
            {m.sources && m.sources.length > 0 && (
              <div className="sources">
                Sources: {[...new Set(m.sources.map((s) => s.page))].sort((a, b) => a - b).map((p) => `p.${p}`).join(', ')}
                {m.model && <> · {m.model}</>}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </section>

      <form onSubmit={ask} className="ask">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={doc ? 'Ask about the PDF…' : 'Upload a PDF first'}
          disabled={!doc || busy}
        />
        <button disabled={!doc || busy || !input.trim()}>{busy ? '…' : 'Send'}</button>
      </form>
    </main>
  );
}
