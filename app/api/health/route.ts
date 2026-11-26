import { NextResponse } from 'next/server';
import { supabase } from '@/lib/server';

export const dynamic = 'force-dynamic';

const RETENTION_DAYS = 7;

// Pinged daily by GitHub Actions cron: keeps the free Supabase project awake
// and deletes PDFs older than RETENTION_DAYS (chunks are removed via ON DELETE CASCADE).
export async function GET() {
  const db = supabase();
  const { error } = await db.from('documents').select('id', { head: true, count: 'exact' });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count, error: delErr } = await db.from('documents').delete({ count: 'exact' }).lt('created_at', cutoff);
  return NextResponse.json({ ok: !delErr, deleted: count ?? 0, error: delErr?.message ?? null }, { status: delErr ? 500 : 200 });
}
