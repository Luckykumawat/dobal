'use client';

import { FormEvent, ReactElement, ReactNode, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ProgressEvent, StepStatus } from '@/lib/progress';

const STORAGE_KEY = 'ai-pdf-chat:v2';
const MAX_MB = 4;

type Step = { id: string; label: string; status: StepStatus; detail?: string; startedAt: number; endedAt?: number };
type Doc = { id: string; name: string; pages: number };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  attachment?: Doc;
  steps?: Step[];
  sources?: { page: number }[];
  model?: string;
  pending?: boolean;
};
type Conversation = { id: string; title: string; doc: Doc | null; messages: Msg[]; updatedAt: number };
type Pending = {
  name: string;
  status: 'uploading' | 'ready' | 'error';
  label: string;
  doc?: Doc;
  error?: string;
  abort?: AbortController;
};

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

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
  return steps.map((s) => (s.id === e.id ? { ...s, ...e, endedAt: e.status === 'active' ? undefined : now } : s));
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="steps">
      {steps.map((s) => (
        <li key={s.id} className={`step ${s.status}`}>
          <span className="icon">{s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : '•'}</span>
          <span>{s.label}</span>
          {s.detail && <span className="detail">· {s.detail}</span>}
          <span className="time">{(((s.endedAt ?? Date.now()) - s.startedAt) / 1000).toFixed(1)}s</span>
        </li>
      ))}
    </ul>
  );
}

/** "Thinking…" while running, then a collapsible "Thought for Xs". */
function Activity({ steps, pending }: { steps: Step[]; pending?: boolean }) {
  const [open, setOpen] = useState(false);
  if (pending) {
    const current = [...steps].reverse().find((s) => s.status === 'active');
    return <div className="thinking shimmer">{current?.label ?? 'Thinking'}</div>;
  }
  if (!steps.length) return null;
  const total = ((Math.max(...steps.map((s) => s.endedAt ?? s.startedAt)) - steps[0].startedAt) / 1000).toFixed(0);
  return (
    <div className="activity">
      <button type="button" className="activity-toggle" onClick={() => setOpen((o) => !o)}>
        Thought for {total}s <span className={`chev ${open ? 'open' : ''}`}>›</span>
      </button>
      {open && <StepList steps={steps} />}
    </div>
  );
}

function FileCard({ name, sub, error, loading, onRemove }: { name: string; sub: string; error?: boolean; loading?: boolean; onRemove?: () => void }) {
  return (
    <div className={`file-card ${error ? 'error' : ''}`}>
      <span className="file-icon">{loading ? <span className="spinner" /> : <PdfIcon />}</span>
      <span className="file-meta">
        <span className="file-name" title={name}>{name}</span>
        <span className="file-sub">{sub}</span>
      </span>
      {onRemove && (
        <button type="button" className="file-remove" aria-label="Remove file" onClick={onRemove}>
          <XIcon />
        </button>
      )}
    </div>
  );
}

export default function Home() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const active = convs.find((c) => c.id === activeId) ?? null;
  const messages = active?.messages ?? [];
  const empty = messages.length === 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Restore chat history after refresh.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved?.convs)) {
        setConvs(saved.convs);
        setActiveId(saved.activeId ?? null);
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    if (window.innerWidth < 768) setSidebarOpen(false);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const clean = convs
      .filter((c) => c.messages.length)
      .slice(0, 30)
      .map((c) => ({
        ...c,
        messages: c.messages.filter((m) => !m.pending).map(({ steps: _s, ...m }) => m).slice(-50),
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ convs: clean, activeId }));
  }, [convs, activeId, restored]);

  function updateConv(id: string, fn: (c: Conversation) => Conversation) {
    setConvs((all) => all.map((c) => (c.id === id ? fn(c) : c)));
  }

  function newChat() {
    pending?.abort?.abort();
    setPending(null);
    setActiveId(null);
    setInput('');
    setError('');
    if (window.innerWidth < 768) setSidebarOpen(false);
    inputRef.current?.focus();
  }

  function removePending() {
    pending?.abort?.abort();
    setPending(null);
  }

  async function attach(file: File) {
    setError('');
    if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are allowed');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`PDF must be under ${MAX_MB} MB`);
      return;
    }
    pending?.abort?.abort();
    const abort = new AbortController();
    setPending({ name: file.name, status: 'uploading', label: 'Uploading…', abort });
    const set = (p: Partial<Pending>) => setPending((cur) => (cur?.abort === abort ? { ...cur, ...p } : cur));
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: form, signal: abort.signal });
      await readProgress(res, (e) => {
        if (e.type === 'step' && e.status === 'active') set({ label: `${e.label}…` });
        if (e.type === 'document') set({ status: 'ready', label: `PDF · ${e.document.pages} pages`, doc: e.document });
        if (e.type === 'error') throw new Error(e.message);
      });
    } catch (e) {
      if (abort.signal.aborted) return;
      const message = e instanceof Error ? e.message : 'Upload failed';
      set({ status: 'error', label: message, error: message });
    }
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (busy || pending?.status === 'uploading') return;
    const attachment = pending?.status === 'ready' ? pending.doc : undefined;
    const doc = attachment ?? active?.doc ?? null;
    const question = input.trim() || (attachment ? 'Summarize this document.' : '');
    if (!doc || !question) return;

    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setPending(null);
    setError('');
    setBusy(true);

    let id = active?.id;
    const history = messages.map(({ role, content }) => ({ role, content }));
    const userMsg: Msg = { role: 'user', content: question, attachment };
    const botMsg: Msg = { role: 'assistant', content: '', steps: [], pending: true };
    if (!id) {
      id = uid();
      const conv: Conversation = { id, title: question.slice(0, 40), doc, messages: [userMsg, botMsg], updatedAt: Date.now() };
      setConvs((all) => [conv, ...all]);
      setActiveId(id);
    } else {
      updateConv(id, (c) => ({ ...c, doc, messages: [...c.messages, userMsg, botMsg], updatedAt: Date.now() }));
      setConvs((all) => [...all.filter((c) => c.id === id), ...all.filter((c) => c.id !== id)]);
    }
    const convId = id;
    const updateLast = (fn: (m: Msg) => Msg) =>
      updateConv(convId, (c) => ({ ...c, messages: [...c.messages.slice(0, -1), fn(c.messages[c.messages.length - 1])] }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc.id, question, history }),
      });
      await readProgress(res, (ev) => {
        if (ev.type === 'step') updateLast((m) => ({ ...m, steps: applyStep(m.steps ?? [], ev) }));
        if (ev.type === 'delta') updateLast((m) => ({ ...m, content: m.content + ev.text }));
        if (ev.type === 'answer')
          updateLast((m) => ({ ...m, content: ev.text, sources: ev.sources, model: ev.model, pending: false }));
        if (ev.type === 'error') throw new Error(ev.message);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat failed';
      updateLast((m) => ({ ...m, pending: false, content: m.content || `⚠️ ${message}` }));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  const canSend =
    !busy && pending?.status !== 'uploading' && Boolean(input.trim() || pending?.status === 'ready') &&
    Boolean(pending?.status === 'ready' || active?.doc);

  const composer = (
    <form onSubmit={ask} className={`composer ${pending ? 'stacked' : ''}`}>
      {pending && (
        <div className="composer-files">
          <FileCard
            name={pending.name}
            sub={pending.label}
            loading={pending.status === 'uploading'}
            error={pending.status === 'error'}
            onRemove={removePending}
          />
        </div>
      )}
      <button type="button" className="icon-btn plus" title="Add PDF" onClick={() => fileRef.current?.click()}>
        <PlusIcon />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) attach(f);
        }}
      />
      <textarea
        ref={inputRef}
        rows={1}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={active?.doc || pending ? 'Ask anything' : 'Add a PDF with + to start'}
      />
      <button className="send-btn" aria-label="Send" disabled={!canSend && !busy}>
        {busy ? <span className="stop-square" /> : <ArrowUpIcon />}
      </button>
    </form>
  );

  return (
    <div className={`app ${sidebarOpen ? 'with-sidebar' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <span className="brand">AI PDF Chat</span>
          <button type="button" className="icon-btn" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}>
            <SidebarIcon />
          </button>
        </div>
        <button type="button" className="side-item" onClick={newChat}>
          <EditIcon /> New chat
        </button>
        <div className="side-label">Recents</div>
        <nav className="side-list">
          {convs.map((c) => (
            <div key={c.id} className={`side-item conv ${c.id === activeId ? 'active' : ''}`}>
              <button
                type="button"
                className="conv-title"
                onClick={() => {
                  pending?.abort?.abort();
                  setPending(null);
                  setActiveId(c.id);
                  if (window.innerWidth < 768) setSidebarOpen(false);
                }}
              >
                {c.title}
              </button>
              <button
                type="button"
                className="conv-del"
                aria-label="Delete chat"
                onClick={() => {
                  setConvs((all) => all.filter((x) => x.id !== c.id));
                  if (c.id === activeId) setActiveId(null);
                }}
              >
                <XIcon />
              </button>
            </div>
          ))}
        </nav>
      </aside>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      <div className="main">
        <header className="topbar">
          {!sidebarOpen && (
            <button type="button" className="icon-btn" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
              <SidebarIcon />
            </button>
          )}
          <span className="topbar-title">{active?.title ?? 'AI PDF Chat'}</span>
        </header>

        <main className={`thread ${empty ? 'empty' : ''}`}>
          <div className="thread-inner">
            {empty && <h1 className="hero">What&apos;s in your PDF today?</h1>}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === 'user' ? (
                  <>
                    {m.attachment && <FileCard name={m.attachment.name} sub="PDF" />}
                    <div className="user-bubble">{m.content}</div>
                  </>
                ) : (
                  <>
                    {m.steps && (m.pending ? !m.content : true) && <Activity steps={m.steps} pending={m.pending} />}
                    {m.content && (
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    )}
                    {!m.pending && m.content && (
                      <div className="msg-actions">
                        <CopyButton text={m.content} />
                        {m.sources && m.sources.length > 0 && (
                          <span className="sources">
                            Sources: {[...new Set(m.sources.map((s) => s.page))].sort((a, b) => a - b).map((p) => `p.${p}`).join(', ')}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            <div ref={endRef} />
            {empty && (
              <>
                {error && <p className="error" role="alert">{error}</p>}
                {composer}
              </>
            )}
          </div>
        </main>

        {!empty && (
          <div className="composer-dock">
            {error && <p className="error" role="alert">{error}</p>}
            {composer}
            <p className="disclaimer">Answers come only from your PDF. AI can make mistakes.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Icons ---------- */
const svg = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function PlusIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2" {...svg}><path d="M12 5v14M5 12h14" /></svg>;
}
function ArrowUpIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="2.5" {...svg}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
}
function XIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2.5" {...svg}><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
function CopyIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2" {...svg}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
}
function CheckIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2.5" {...svg}><path d="M20 6 9 17l-5-5" /></svg>;
}
function EditIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="2" {...svg}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}
function SidebarIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2" {...svg}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>;
}
function PdfIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" strokeWidth="1.8" {...svg}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <text x="12" y="17.5" textAnchor="middle" fontSize="5.5" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
    </svg>
  );
}

function CopyButton({ text, label }: { text: string; label?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={label ? 'copy-label' : 'icon-btn small'}
      title="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {label && <span>{copied ? 'Copied' : 'Copy'}</span>}
    </button>
  );
}

/** ChatGPT-style box for code / copyable text (emails, messages, templates). */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = (Array.isArray(children) ? children[0] : children) as ReactElement<{ className?: string; children?: ReactNode }>;
  const lang = /language-([\w-]+)/.exec(code?.props?.className ?? '')?.[1] ?? 'text';
  const text = String(code?.props?.children ?? '').replace(/\n$/, '');
  const plain = lang === 'text' || lang === 'plaintext';
  return (
    <div className="code-box">
      <div className="code-head">
        <span>{plain ? '' : lang}</span>
        <CopyButton text={text} label />
      </div>
      <pre className={plain ? 'prose-pre' : ''}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
