import { NextResponse } from 'next/server';
import { supabase } from '@/lib/server';

export const runtime = 'nodejs';

const ALLOWED_ORIGINS = new Set([
  'https://dobal.vercel.app',
  'https://golangi.web.app',
  'https://drivepool-3s9r.onrender.com',
  'https://labelshorting.netlify.app',
  'https://dot-seller.vercel.app',
  'https://listing-studio.gonesharma033.workers.dev',
  'https://dotworkspace.vercel.app',
]);

const KNOWN_APPS = new Set([
  'dobal',
  'drivepool',
  'gather',
  'label-sorter',
  'dot-seller',
  'listing-studio',
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowed =
    ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

async function authenticate(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await supabase().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export async function GET(req: Request) {
  const headers = corsHeaders(req);
  const user = await authenticate(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });

  const { data, error } = await supabase()
    .from('dot_user_apps')
    .select('app_id')
    .eq('user_id', user.id)
    .order('first_login_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
  return NextResponse.json(
    { apps: (data ?? []).map((r) => r.app_id), user: { id: user.id, email: user.email || '' } },
    { headers },
  );
}

export async function POST(req: Request) {
  const headers = corsHeaders(req);
  const user = await authenticate(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });

  const body = (await req.json().catch(() => ({}))) as { app?: string };
  const appId = typeof body.app === 'string' ? body.app.trim().toLowerCase() : '';

  const db = supabase();
  if (KNOWN_APPS.has(appId)) {
    await db
      .from('dot_user_apps')
      .upsert(
        { user_id: user.id, app_id: appId, last_login_at: new Date().toISOString() },
        { onConflict: 'user_id,app_id' },
      );
  }

  const { data, error } = await db
    .from('dot_user_apps')
    .select('app_id')
    .eq('user_id', user.id)
    .order('first_login_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
  return NextResponse.json(
    { apps: (data ?? []).map((r) => r.app_id), user: { id: user.id, email: user.email || '' } },
    { headers },
  );
}
