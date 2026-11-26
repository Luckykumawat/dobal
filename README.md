# 📄 AI PDF Chat

Upload a PDF and chat with it. Answers come with page citations.

**Stack:** Next.js 15 · Gemini (embeddings + chat) · Supabase Postgres + pgvector · Vercel

## How it works (RAG)
1. PDF → text per page (`unpdf`) → ~1000-char chunks
2. Chunks → Gemini embeddings (768-dim) → stored in `chunks` table (pgvector)
3. Question → embedding → `match_chunks()` cosine search → top 6 chunks
4. Chunks + question → Gemini → streamed answer with page sources

## Setup
1. **Supabase:** create a project → SQL Editor → run `supabase/schema.sql`.
2. **Gemini key:** https://aistudio.google.com/apikey
3. `cp .env.example .env.local` and fill in the values (service role key is server-only).
4. `npm install && npm run dev` → http://localhost:3000

## Deploy (Vercel)
- Import the repo on Vercel, add the same env vars, deploy.
- Keep-alive: in the GitHub repo add secret `APP_URL` (e.g. `https://your-app.vercel.app`). `.github/workflows/keep-alive.yml` pings `/api/health` every 3 days so the free Supabase project doesn't pause.

## Roadmap
- [ ] Supabase Auth (per-user documents)
- [ ] Multiple PDFs per chat
- [ ] Saved chat history
- [ ] OCR for scanned PDFs (Gemini vision)
