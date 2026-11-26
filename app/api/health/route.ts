import { NextResponse } from 'next/server';
import { supabase } from '@/lib/server';

export const dynamic = 'force-dynamic';

// Pinged by GitHub Actions cron so the free Supabase project does not pause.
export async function GET() {
  const { error } = await supabase().from('documents').select('id', { head: true, count: 'exact' });
  return NextResponse.json({ ok: !error, error: error?.message ?? null }, { status: error ? 500 : 200 });
}
