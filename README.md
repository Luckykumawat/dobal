<p align="center">
  <img src="public/dobal-logo.png" width="96" alt="Dobal logo" />
</p>

<h1 align="center">Dobal</h1>

<p align="center">Your AI assistant: ask anything, chat with PDFs, and build your own study Notes.</p>

**Stack:** Next.js 15 · Gemini (chat + embeddings) · Supabase Postgres + pgvector · Upstash Redis · Vercel

## Features
- 💬 **Ask anything**: a general AI assistant (like ChatGPT / Claude), with streaming Markdown answers and copyable boxes for emails, messages and code.
- 📄 **Chat with PDFs**: attach a PDF with **+** and get answers with page citations (RAG).
- 📝 **Notes**: select any word or line in an answer, then **Add to Notes**. Dobal asks what you want to know, writes an explanation and saves it with the date and a **back-link** to the exact line in the chat. Notes can be searched, edited and deleted.
- ⏹ Stop generating · ✏️ edit your message · 🔄 regenerate · AI-generated chat titles · chat history in the sidebar.

## How PDF chat works (RAG)
1. PDF → text per page (`unpdf`) → ~1000-char chunks
2. Chunks → Gemini embeddings (768-dim) → stored in the `chunks` table (pgvector)
3. Question → embedding → `match_chunks()` cosine search → top 6 chunks
4. Chunks + question → Gemini → streamed answer with page sources

## Setup
1. **Supabase:** create a project → SQL Editor → run `supabase/schema.sql`.
2. **Gemini key:** https://aistudio.google.com/apikey
3. `cp .env.example .env.local` and fill in the values (the service role key is server-only).
4. `npm install && npm run dev` → http://localhost:3000

## Deploy (Vercel)
- Import the repo on Vercel, add the same env vars, deploy.
- **Rate limiting:** add *Upstash for Redis* from the Vercel Marketplace (sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`). Without it, an in-memory limiter is used.
- **Keep-alive + cleanup:** add the GitHub secret `APP_URL` (e.g. `https://your-app.vercel.app`). `.github/workflows/keep-alive.yml` calls `/api/health` daily, which keeps the free Supabase project awake and deletes PDFs older than 7 days.

## Roadmap
- [ ] Supabase Auth + sync chats and notes across devices
- [ ] Multiple PDFs per chat
- [ ] OCR for scanned PDFs (Gemini vision)
