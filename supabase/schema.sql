-- Run in Supabase SQL Editor
create extension if not exists vector;

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pages int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists chunks (
  id bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  page int not null,
  content text not null,
  embedding vector(768) not null
);

create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- Similarity search
create or replace function match_chunks(
  query_embedding vector(768),
  doc_id uuid,
  match_count int default 5
)
returns table (id bigint, page int, content text, similarity float)
language sql stable
as $$
  select c.id, c.page, c.content, 1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where c.document_id = doc_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Only the server (service role) accesses these tables.
alter table documents enable row level security;
alter table chunks enable row level security;
