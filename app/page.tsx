'use client';

import { FormEvent, ReactElement, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ProgressEvent, StepStatus } from '@/lib/progress';

const STORAGE_KEY = 'ai-pdf-chat:v2';
const NOTES_KEY = 'dobal:notes:v1';
const MAX_MB = 4;

type Step = { id: string; label: string; status: StepStatus; detail?: string; startedAt: number; endedAt?: number };
type Doc = { id: string; name: string; pages: number };
type Msg = {
  id: string;
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
type Note = {
  id: string;
  text: string; // the selected word / line
  question: string; // what the user wanted to know (may be empty)
  explanation: string;
  createdAt: number;
  updatedAt?: number;
  convId: string;
  msgId: string;
  convTitle: string;
  status?: 'writing' | 'error'; // undefined = ready
  error?: string;
  context?: string; // surrounding answer, kept so a failed note can be retried
};
type Selection = { text: string; convId: string; msgId: string; x: number; y: number };
type NoteDraft = {
  id: string;
  text: string;
  convId: string;
  msgId: string;
  context: string;
  question: string;
  status: 'ask' | 'writing' | 'error';
  explanation: string;
  error?: string;
};

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

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

/** Finds `text` inside `root` (ignoring whitespace differences) and returns a DOM Range for it. */
function findTextRange(root: Element, text: string): Range | null {
  const map: [Text, number][] = [];
  let flat = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.nodeValue ?? '';
    for (let i = 0; i < value.length; i++) {
      if (/\s/.test(value[i])) continue;
      flat += value[i];
      map.push([node, i]);
    }
  }
  const target = text.replace(/\s+/g, '');
  const idx = target ? flat.indexOf(target) : -1;
  if (idx < 0) return null;
  const [startNode, startOff] = map[idx];
  const [endNode, endOff] = map[idx + target.length - 1];
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff + 1);
  return range;
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

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
      {children}
    </ReactMarkdown>
  );
}

export default function Home() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [view, setView] = useState<'chat' | 'notes'>('chat');
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [toast, setToast] = useState<{ text: string; noteId?: string } | null>(null);
  const [jump, setJump] = useState<{ msgId: string; text: string } | null>(null);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const noteAborts = useRef(new Map<string, AbortController>());
  const chatAbort = useRef<AbortController | null>(null);
  const [editingMsg, setEditingMsg] = useState<{ id: string; text: string } | null>(null);

  const active = convs.find((c) => c.id === activeId) ?? null;
  const messages = active?.messages ?? [];
  const empty = messages.length === 0;
  const isMobile = () => typeof window !== 'undefined' && window.innerWidth < 768;

  useEffect(() => {
    if (!jump) endRef.current?.scrollIntoView({ behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, messages[messages.length - 1]?.content]);

  // ---------- Restore + persist (browser storage) ----------
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved?.convs)) {
        const withIds = (saved.convs as Conversation[]).map((c) => ({
          ...c,
          messages: c.messages.map((m) => ({ ...m, id: m.id || uid() })),
        }));
        setConvs(withIds);
        setActiveId(saved.activeId ?? null);
      }
      const savedNotes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
      if (Array.isArray(savedNotes))
        setNotes(
          (savedNotes as Note[]).map((n) =>
            n.status === 'writing' ? { ...n, status: 'error', error: 'Interrupted. Please retry.' } : n,
          ),
        );
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    if (isMobile()) setSidebarOpen(false);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const clean = convs
      .filter((c) => c.messages.length)
      .slice(0, 50)
      .map((c) => ({
        ...c,
        messages: c.messages.filter((m) => !m.pending).map(({ steps: _s, ...m }) => m).slice(-100),
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ convs: clean, activeId }));
  }, [convs, activeId, restored]);

  useEffect(() => {
    if (restored) localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  }, [notes, restored]);

  // ---------- Toast ----------
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------- Text selection → "Add to Notes" button ----------
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? '';
        if (!sel || sel.isCollapsed || !text || sel.rangeCount === 0) return setSelection(null);
        const range = sel.getRangeAt(0);
        const el = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement);
        const startMsg = el(range.startContainer)?.closest('[data-msg-id]');
        const endMsg = el(range.endContainer)?.closest('[data-msg-id]');
        if (!startMsg || startMsg !== endMsg || startMsg.getAttribute('data-role') !== 'assistant') return setSelection(null);
        if (!el(range.commonAncestorContainer)?.closest('.markdown')) return setSelection(null);
        const rect = range.getBoundingClientRect();
        setSelection({
          text: text.slice(0, 2000),
          convId: startMsg.getAttribute('data-conv-id') ?? '',
          msgId: startMsg.getAttribute('data-msg-id') ?? '',
          x: rect.left + rect.width / 2,
          y: rect.top,
        });
      }, 150);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, []);

  // ---------- Back-link: jump to the source line and highlight it ----------
  useEffect(() => {
    if (!jump || view !== 'chat') return;
    const run = () => {
      const msgEl = document.querySelector(`[data-msg-id="${jump.msgId}"]`);
      if (!msgEl) {
        setToast({ text: 'Source message not found (chat may have been deleted)' });
        return setJump(null);
      }
      const md = msgEl.querySelector('.markdown') ?? msgEl;
      const range = findTextRange(md, jump.text);
      const HighlightCtor = (globalThis as unknown as { Highlight?: new (r: Range) => unknown }).Highlight;
      const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
      if (range && HighlightCtor && registry) {
        registry.set('note-source', new HighlightCtor(range));
        const r = range.getBoundingClientRect();
        const main = document.querySelector('.main');
        main?.scrollBy({ top: r.top - window.innerHeight / 2, behavior: 'smooth' });
        setTimeout(() => registry.delete('note-source'), 6000);
      } else {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      msgEl.classList.add('flash');
      setTimeout(() => msgEl.classList.remove('flash'), 2000);
      setJump(null);
    };
    const t = setTimeout(run, 120);
    return () => clearTimeout(t);
  }, [jump, view, activeId]);

  useEffect(() => {
    if (view !== 'notes' || !focusNoteId) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`note-${focusNoteId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 2000);
      setFocusNoteId(null);
    }, 100);
    return () => clearTimeout(t);
  }, [view, focusNoteId]);

  function updateConv(id: string, fn: (c: Conversation) => Conversation) {
    setConvs((all) => all.map((c) => (c.id === id ? fn(c) : c)));
  }

  function openChat(id: string | null) {
    pending?.abort?.abort();
    setPending(null);
    setActiveId(id);
    setView('chat');
    setError('');
    if (isMobile()) setSidebarOpen(false);
  }

  function openNotes(noteId?: string) {
    setView('notes');
    if (noteId) setFocusNoteId(noteId);
    if (isMobile()) setSidebarOpen(false);
  }

  // ---------- PDF attach ----------
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
        if (e.type === 'document') set({ status: 'ready', label: `PDF · ${e.document.pages} page${e.document.pages === 1 ? '' : 's'}`, doc: e.document });
        if (e.type === 'error') throw new Error(e.message);
      });
    } catch (e) {
      if (abort.signal.aborted) return;
      const message = e instanceof Error ? e.message : 'Upload failed';
      set({ status: 'error', label: message, error: message });
    }
  }

  // ---------- Chat ----------
  type HistoryItem = { role: 'user' | 'assistant'; content: string };

  /** Streams an answer into the last (pending) assistant message of `convId`. Returns the final text. */
  async function runChat(convId: string, doc: Doc | null, question: string, history: HistoryItem[]) {
    const ctrl = new AbortController();
    chatAbort.current = ctrl;
    setBusy(true);
    const updateLast = (fn: (m: Msg) => Msg) =>
      updateConv(convId, (c) => ({ ...c, messages: [...c.messages.slice(0, -1), fn(c.messages[c.messages.length - 1])] }));
    let final = '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc?.id, question, history }),
        signal: ctrl.signal,
      });
      await readProgress(res, (ev) => {
        if (ev.type === 'step') updateLast((m) => ({ ...m, steps: applyStep(m.steps ?? [], ev) }));
        if (ev.type === 'delta') {
          final += ev.text;
          updateLast((m) => ({ ...m, content: m.content + ev.text }));
        }
        if (ev.type === 'answer') {
          final = ev.text;
          updateLast((m) => ({ ...m, content: ev.text, sources: ev.sources, model: ev.model, pending: false }));
        }
        if (ev.type === 'error') {
          // PDF was auto-deleted: detach it so the next messages work as normal chat.
          if (ev.code === 'PDF_EXPIRED') updateConv(convId, (c) => ({ ...c, doc: null }));
          throw new Error(ev.message);
        }
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        updateLast((m) => ({ ...m, pending: false, content: m.content ? `${m.content}\n\n_⏹ Stopped_` : '_⏹ Stopped_' }));
      } else {
        const message = err instanceof Error ? err.message : 'Chat failed';
        updateLast((m) => ({ ...m, pending: false, content: m.content || `⚠️ ${message}` }));
      }
    } finally {
      if (chatAbort.current === ctrl) chatAbort.current = null;
      setBusy(false);
      inputRef.current?.focus();
    }
    return final;
  }

  function stopChat() {
    chatAbort.current?.abort();
  }

  async function makeTitle(convId: string, question: string, answer: string) {
    try {
      const res = await fetch('/api/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer }),
      });
      const { title } = await res.json();
      if (title) updateConv(convId, (c) => ({ ...c, title }));
    } catch {
      /* keep the fallback title */
    }
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (busy || pending?.status === 'uploading') return;
    const attachment = pending?.status === 'ready' ? pending.doc : undefined;
    const doc = attachment ?? active?.doc ?? null;
    const question = input.trim() || (attachment ? 'Summarize this document.' : '');
    if (!question) return;

    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setPending(null);
    setError('');

    let id = active?.id;
    const isNew = !id;
    const history = messages.map(({ role, content }) => ({ role, content }));
    const userMsg: Msg = { id: uid(), role: 'user', content: question, attachment };
    const botMsg: Msg = { id: uid(), role: 'assistant', content: '', steps: [], pending: true };
    if (!id) {
      id = uid();
      const conv: Conversation = { id, title: question.slice(0, 40), doc, messages: [userMsg, botMsg], updatedAt: Date.now() };
      setConvs((all) => [conv, ...all]);
      setActiveId(id);
    } else {
      updateConv(id, (c) => ({ ...c, doc, messages: [...c.messages, userMsg, botMsg], updatedAt: Date.now() }));
      setConvs((all) => [...all.filter((c) => c.id === id), ...all.filter((c) => c.id !== id)]);
    }
    const answer = await runChat(id, doc, question, history);
    if (isNew && answer) makeTitle(id, question, answer);
  }

  /** Re-asks the last question and replaces the last answer. */
  function regenerate() {
    if (!active || busy) return;
    const msgs = active.messages;
    const userIdx = msgs.length - 2;
    if (userIdx < 0 || msgs[userIdx].role !== 'user') return;
    const history = msgs.slice(0, userIdx).map(({ role, content }) => ({ role, content }));
    const botMsg: Msg = { id: uid(), role: 'assistant', content: '', steps: [], pending: true };
    updateConv(active.id, (c) => ({ ...c, messages: [...c.messages.slice(0, -1), botMsg], updatedAt: Date.now() }));
    runChat(active.id, active.doc, msgs[userIdx].content, history);
  }

  /** Edits a user message: drops everything after it and asks again (like ChatGPT). */
  function saveEdit(msgId: string, text: string) {
    if (!active || busy || !text.trim()) return;
    const idx = active.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const history = active.messages.slice(0, idx).map(({ role, content }) => ({ role, content }));
    const edited: Msg = { ...active.messages[idx], content: text.trim() };
    const botMsg: Msg = { id: uid(), role: 'assistant', content: '', steps: [], pending: true };
    updateConv(active.id, (c) => ({ ...c, messages: [...c.messages.slice(0, idx), edited, botMsg], updatedAt: Date.now() }));
    setEditingMsg(null);
    runChat(active.id, active.doc, edited.content, history);
  }

  // ---------- Notes ----------
  function startNote() {
    if (!selection) return;
    const conv = convs.find((c) => c.id === selection.convId);
    const msg = conv?.messages.find((m) => m.id === selection.msgId);
    setDraft({
      id: uid(),
      text: selection.text,
      convId: selection.convId,
      msgId: selection.msgId,
      context: msg?.content ?? '',
      question: '',
      status: 'ask',
      explanation: '',
    });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  const closeDraft = useCallback(() => setDraft(null), []);

  /** Saves the note immediately and writes the explanation in the background. */
  function writeNote(d: NoteDraft) {
    const conv = convs.find((c) => c.id === d.convId);
    const note: Note = {
      id: d.id,
      text: d.text,
      question: d.question.trim(),
      explanation: '',
      createdAt: Date.now(),
      convId: d.convId,
      msgId: d.msgId,
      convTitle: conv?.title ?? 'Chat',
      status: 'writing',
      context: d.context.slice(0, 4000),
    };
    setNotes((all) => [note, ...all]);
    setDraft(null);
    setToast({ text: 'Writing your note in the background…' });
    generateNote(note);
  }

  async function generateNote(note: Note) {
    noteAborts.current.get(note.id)?.abort();
    const abort = new AbortController();
    noteAborts.current.set(note.id, abort);
    const patch = (fn: (n: Note) => Note) => setNotes((all) => all.map((n) => (n.id === note.id ? fn(n) : n)));
    patch((n) => ({ ...n, status: 'writing', error: undefined, explanation: '' }));
    try {
      const res = await fetch('/api/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: note.text, question: note.question, context: note.context ?? '' }),
        signal: abort.signal,
      });
      await readProgress(res, (ev) => {
        if (ev.type === 'delta') patch((n) => ({ ...n, explanation: n.explanation + ev.text }));
        if (ev.type === 'answer') patch((n) => ({ ...n, explanation: ev.text }));
        if (ev.type === 'error') throw new Error(ev.message);
      });
      patch((n) => ({ ...n, status: undefined, context: undefined }));
      setToast({ text: 'Note added', noteId: note.id });
    } catch (e) {
      if (abort.signal.aborted) return;
      const message = e instanceof Error ? e.message : 'Could not create note';
      patch((n) => ({ ...n, status: 'error', error: message }));
      setToast({ text: 'Note failed. Open Notes to retry', noteId: note.id });
    } finally {
      if (noteAborts.current.get(note.id) === abort) noteAborts.current.delete(note.id);
    }
  }

  function goToSource(note: Note) {
    if (!convs.some((c) => c.id === note.convId)) {
      setToast({ text: 'The original chat was deleted' });
      return;
    }
    openChat(note.convId);
    setJump({ msgId: note.msgId, text: note.text });
  }

  const canSend = !busy && pending?.status !== 'uploading' && Boolean(input.trim() || pending?.status === 'ready');

  const composer = (
    <form onSubmit={ask} className={`composer ${pending ? 'stacked' : ''}`}>
      {pending && (
        <div className="composer-files">
          <FileCard
            name={pending.name}
            sub={pending.label}
            loading={pending.status === 'uploading'}
            error={pending.status === 'error'}
            onRemove={() => {
              pending.abort?.abort();
              setPending(null);
            }}
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
        placeholder={pending || active?.doc ? 'Ask anything about your PDF' : 'Ask anything'}
      />
      {busy ? (
        <button type="button" className="send-btn" aria-label="Stop generating" title="Stop" onClick={stopChat}>
          <span className="stop-square" />
        </button>
      ) : (
        <button className="send-btn" aria-label="Send" disabled={!canSend}>
          <ArrowUpIcon />
        </button>
      )}
    </form>
  );

  return (
    <div className={`app ${sidebarOpen ? 'with-sidebar' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <span className="brand"><Logo size={26} /> Dobal</span>
          <button type="button" className="icon-btn" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}>
            <SidebarIcon />
          </button>
        </div>
        <button type="button" className="side-item" onClick={() => openChat(null)}>
          <EditIcon /> New chat
        </button>
        <button type="button" className={`side-item ${view === 'notes' ? 'active' : ''}`} onClick={() => openNotes()}>
          <NoteIcon /> Notes
          {notes.some((n) => n.status === 'writing') ? (
            <span className="badge"><span className="spinner tiny" /></span>
          ) : (
            notes.length > 0 && <span className="badge">{notes.length}</span>
          )}
        </button>
        <div className="side-label">Recents</div>
        <nav className="side-list">
          {convs.map((c) => (
            <div key={c.id} className={`side-item conv ${view === 'chat' && c.id === activeId ? 'active' : ''}`}>
              <button type="button" className="conv-title" onClick={() => openChat(c.id)}>
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

      <div className="main" onScroll={() => selection && setSelection(null)}>
        <header className="topbar">
          {!sidebarOpen && (
            <button type="button" className="icon-btn" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
              <SidebarIcon />
            </button>
          )}
          <span className="topbar-title">{view === 'notes' ? 'Notes' : active?.title ?? 'Dobal'}</span>
        </header>

        {view === 'notes' ? (
          <NotesView
            notes={notes}
            convExists={(id) => convs.some((c) => c.id === id)}
            onGoToSource={goToSource}
            onSave={(id, patch) =>
              setNotes((all) => all.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n)))
            }
            onDelete={(id) => {
              noteAborts.current.get(id)?.abort();
              setNotes((all) => all.filter((n) => n.id !== id));
            }}
            onRetry={(n) => generateNote(n)}
          />
        ) : (
          <>
            <main className={`thread ${empty ? 'empty' : ''}`}>
              {empty && <div className="glow" aria-hidden />}
              <div className="thread-inner">
                {empty && (
                  <div className="hero-wrap">
                    <Logo size={52} />
                    <h1 className="hero">What can I help with?</h1>
                  </div>
                )}
                {messages.map((m, idx) => (
                  <div key={m.id} className={`msg ${m.role}`} data-msg-id={m.id} data-role={m.role} data-conv-id={active?.id}>
                    {m.role === 'user' ? (
                      <>
                        {m.attachment && <FileCard name={m.attachment.name} sub="PDF" />}
                        {editingMsg?.id === m.id ? (
                          <div className="edit-box">
                            <textarea
                              autoFocus
                              className="edit-input"
                              value={editingMsg.text}
                              rows={Math.min(10, Math.max(2, editingMsg.text.split('\n').length))}
                              onChange={(e) => setEditingMsg({ id: m.id, text: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditingMsg(null);
                                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                  e.preventDefault();
                                  saveEdit(m.id, editingMsg.text);
                                }
                              }}
                            />
                            <div className="modal-actions">
                              <button type="button" className="btn ghost" onClick={() => setEditingMsg(null)}>Cancel</button>
                              <button
                                type="button"
                                className="btn primary"
                                disabled={busy || !editingMsg.text.trim()}
                                onClick={() => saveEdit(m.id, editingMsg.text)}
                              >
                                Send
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="user-bubble">{m.content}</div>
                            <div className="msg-actions user-actions">
                              <CopyButton text={m.content} />
                              {!busy && (
                                <button
                                  type="button"
                                  className="icon-btn small"
                                  title="Edit message"
                                  onClick={() => setEditingMsg({ id: m.id, text: m.content })}
                                >
                                  <EditIcon />
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        {m.steps && (m.pending ? !m.content : true) && <Activity steps={m.steps} pending={m.pending} />}
                        {m.content && (
                          <div className="markdown">
                            <Markdown>{m.content}</Markdown>
                          </div>
                        )}
                        {!m.pending && m.content && (
                          <div className="msg-actions">
                            <CopyButton text={m.content} />
                            {idx === messages.length - 1 && !busy && (
                              <button type="button" className="icon-btn small" title="Regenerate" onClick={regenerate}>
                                <RefreshIcon />
                              </button>
                            )}
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
                <p className="disclaimer">Tip: select any text in an answer to save it to Notes. Dobal can make mistakes.</p>
              </div>
            )}
          </>
        )}
      </div>

      {selection && !draft && (
        <button
          type="button"
          className="add-note-btn"
          style={{ left: selection.x, top: selection.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={startNote}
        >
          <NoteIcon /> Add to Notes
        </button>
      )}

      {draft && <NoteModal draft={draft} setDraft={setDraft} onClose={closeDraft} onSubmit={writeNote} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.noteId && (
            <button
              type="button"
              onClick={() => {
                openNotes(toast.noteId);
                setToast(null);
              }}
            >
              View
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Add-note dialog ---------- */
function NoteModal({
  draft,
  setDraft,
  onClose,
  onSubmit,
}: {
  draft: NoteDraft;
  setDraft: (fn: (d: NoteDraft | null) => NoteDraft | null) => void;
  onClose: () => void;
  onSubmit: (d: NoteDraft) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Add to Notes">
        <div className="modal-head">
          <span>Add to Notes</span>
          <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <blockquote className="note-quote">{draft.text}</blockquote>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(draft);
          }}
        >
          <label className="modal-label" htmlFor="note-q">What do you want to know about this?</label>
          <textarea
            id="note-q"
            autoFocus
            rows={3}
            className="modal-input"
            placeholder="e.g. Explain with a simple example (optional)"
            value={draft.question}
            onChange={(e) => setDraft((d) => (d ? { ...d, question: e.target.value } : d))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <p className="modal-hint">Dobal writes the note in the background, so you can keep chatting.</p>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary">Add note</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---------- Notes tab ---------- */
function NotesView({
  notes,
  convExists,
  onGoToSource,
  onSave,
  onDelete,
  onRetry,
}: {
  notes: Note[];
  convExists: (id: string) => boolean;
  onGoToSource: (n: Note) => void;
  onSave: (id: string, patch: Partial<Note>) => void;
  onDelete: (id: string) => void;
  onRetry: (n: Note) => void;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string; question: string; explanation: string } | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q
    ? notes.filter((n) => `${n.text} ${n.question} ${n.explanation}`.toLowerCase().includes(q))
    : notes;

  return (
    <main className="notes-page">
      <div className="notes-inner">
        <div className="notes-head">
          <h1>Notes</h1>
          <span className="notes-count">{notes.length} saved</span>
        </div>
        {notes.length > 0 && (
          <input className="notes-search" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}

        {notes.length === 0 && (
          <div className="notes-empty">
            <NoteIcon />
            <p>No notes yet.</p>
            <p className="muted">
              While reading an answer, <b>select any word or line</b> and click <b>Add to Notes</b>. Dobal will explain it
              and save it here with the date and a link back to the chat.
            </p>
          </div>
        )}
        {notes.length > 0 && shown.length === 0 && <p className="muted">No notes match “{query}”.</p>}

        {shown.map((n) => {
          const isEditing = editing?.id === n.id;
          return (
            <article key={n.id} id={`note-${n.id}`} className="note-card">
              <div className="note-meta">
                <span>{fmtDate(n.createdAt)}</span>
                {n.updatedAt && <span>· edited {fmtDate(n.updatedAt)}</span>}
                <span className="note-from">· from “{n.convTitle}”</span>
              </div>

              {isEditing ? (
                <div className="note-edit">
                  <label className="modal-label">Selected text</label>
                  <textarea className="modal-input" rows={2} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                  <label className="modal-label">Your question</label>
                  <input className="modal-input" value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} />
                  <label className="modal-label">Explanation (Markdown supported)</label>
                  <textarea className="modal-input" rows={10} value={editing.explanation} onChange={(e) => setEditing({ ...editing, explanation: e.target.value })} />
                  <div className="modal-actions">
                    <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => {
                        onSave(n.id, { text: editing.text.trim() || n.text, question: editing.question.trim(), explanation: editing.explanation });
                        setEditing(null);
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <blockquote className="note-quote">{n.text}</blockquote>
                  {n.question && <p className="note-asked">You asked: {n.question}</p>}
                  {n.status === 'writing' && !n.explanation && <div className="thinking shimmer note-body">Writing your note…</div>}
                  {n.explanation && (
                    <div className="markdown note-body">
                      <Markdown>{n.explanation}</Markdown>
                    </div>
                  )}
                  {n.status === 'error' && <p className="error note-body">⚠️ {n.error}</p>}
                  <div className="note-actions">
                    {n.status === 'error' && (
                      <button type="button" className="chip" onClick={() => onRetry(n)}>
                        <RefreshIcon /> Retry
                      </button>
                    )}
                    <button type="button" className="chip" disabled={!convExists(n.convId)} onClick={() => onGoToSource(n)}>
                      <LinkIcon /> {convExists(n.convId) ? 'Go to source' : 'Chat deleted'}
                    </button>
                    <button
                      type="button"
                      className="chip"
                      disabled={n.status === 'writing'}
                      onClick={() => setEditing({ id: n.id, text: n.text, question: n.question, explanation: n.explanation })}
                    >
                      <EditIcon /> Edit
                    </button>
                    <CopyButton text={n.explanation} />
                    <button
                      type="button"
                      className="chip danger"
                      onClick={() => {
                        if (confirm('Delete this note?')) onDelete(n.id);
                      }}
                    >
                      <TrashIcon /> Delete
                    </button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}

/* ---------- Icons ---------- */
/** Dobal logo: 8 white circles meeting at the center (flower-of-life style). */
function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-label="Dobal logo" className="logo">
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        return (
          <circle
            key={i}
            cx={(32 + 13 * Math.cos(a)).toFixed(2)}
            cy={(32 + 13 * Math.sin(a)).toFixed(2)}
            r="13"
            stroke="currentColor"
            strokeWidth={size < 32 ? 2.6 : 2}
          />
        );
      })}
    </svg>
  );
}
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
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2" {...svg}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}
function NoteIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2" {...svg}><path d="M4 4h12l4 4v12H4Z" /><path d="M8 10h8M8 14h8M8 18h5" /></svg>;
}
function LinkIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...svg}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>;
}
function TrashIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...svg}><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>;
}
function RefreshIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2" {...svg}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>;
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
