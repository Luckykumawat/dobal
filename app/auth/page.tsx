'use client';

import { FormEvent, Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient, type Session } from '@supabase/supabase-js';

const ALLOWED_ORIGINS = new Set([
  'https://dobal.vercel.app',
  'https://golangi.web.app',
  'https://drivepool-3s9r.onrender.com',
  'https://labelshorting.netlify.app',
  'https://dot-seller.vercel.app',
  'https://listing-studio.gonesharma033.workers.dev',
  'https://dotworkspace.vercel.app',
]);

function isAllowedReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (ALLOWED_ORIGINS.has(u.origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.origin)) {
      return u.toString();
    }
  } catch {
    // ignore invalid URL
  }
  return null;
}

function encodeBase64Url(obj: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function DotAuthInner() {
  const params = useSearchParams();
  const appId = params.get('app') || 'dobal';
  const returnTo = isAllowedReturnTo(params.get('returnTo'));

  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [session, setSession] = useState<Session | null>(null);

  const client = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    return createClient(url, anon);
  }, []);

  async function finishSignIn(active: Session) {
    let apps: string[] = [appId];
    try {
      const res = await fetch('/api/dot-id/apps', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${active.access_token}`,
        },
        body: JSON.stringify({ app: appId }),
      });
      const data = await res.json();
      if (Array.isArray(data.apps)) apps = data.apps;
    } catch {
      // fall back to current app
    }

    const payload = {
      accessToken: active.access_token,
      expiresAt: (active.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
      user: {
        id: active.user.id,
        email: active.user.email || '',
        name: active.user.user_metadata?.full_name || active.user.email?.split('@')[0] || 'Dot User',
      },
      apps,
    };

    try {
      window.localStorage.setItem('dot_id:session:v1', JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }

    if (returnTo) {
      const target = new URL(returnTo);
      target.hash = `dot_id=${encodeBase64Url(payload)}`;
      window.location.assign(target.toString());
    } else {
      window.location.assign('/');
    }
  }

  useEffect(() => {
    if (!client) return;
    client.auth.getSession().then(({ data }) => {
      if (data.session) setSession(data.session);
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, [client]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!client) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { data, error: err } = await client.auth.signUp({ email: email.trim(), password });
        if (err) throw err;
        if (data.session) {
          await finishSignIn(data.session);
        } else {
          setNotice('Check your email to confirm your Dot ID account, then sign in.');
        }
      } else {
        const { data, error: err } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (err) throw err;
        if (data.session) await finishSignIn(data.session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    if (!client) return;
    setError('');
    setBusy(true);
    const redirectTo = window.location.href;
    const { error: err } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    if (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20,
      background: 'radial-gradient(circle at top, #1f1b2e, #0d0d0d 70%)', color: '#f5f5f5',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <section style={{
        width: 'min(400px, 100%)', padding: 28, borderRadius: 24,
        background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.16)', boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <img src="https://dotworkspace.vercel.app/assets/dot-workspace-icon.svg" alt="" width={36} height={20} />
          <strong style={{ fontSize: 16 }}>Dot ID</strong>
        </div>

        {!client ? (
          <p style={{ color: '#fca5a5', fontSize: 13, lineHeight: 1.5 }}>
            Dot ID is not configured yet: add <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in Vercel Environment Variables.
          </p>
        ) : session ? (
          <div>
            <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Continue as {session.user.email}</h1>
            <p style={{ fontSize: 13, color: '#cbd5e1', margin: '0 0 18px' }}>
              Sign in to <strong>{appId}</strong> with your Dot ID.
            </p>
            <button
              type="button"
              onClick={() => finishSignIn(session)}
              style={{ width: '100%', padding: '11px 16px', borderRadius: 12, border: 0, background: '#fff', color: '#111', fontWeight: 600, cursor: 'pointer', marginBottom: 10 }}
            >
              Continue to {appId}
            </button>
            <button
              type="button"
              onClick={async () => { await client.auth.signOut(); setSession(null); }}
              style={{ width: '100%', padding: '10px 16px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#e2e8f0', cursor: 'pointer' }}
            >
              Use another account
            </button>
          </div>
        ) : (
          <>
            <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>
              {mode === 'login' ? 'Sign in with Dot ID' : 'Create your Dot ID'}
            </h1>
            <p style={{ fontSize: 13, color: '#cbd5e1', margin: '0 0 20px' }}>
              One account for your connected Dot Workspace apps.
            </p>

            <button
              type="button"
              disabled={busy}
              onClick={onGoogle}
              style={{ width: '100%', padding: '11px 16px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontWeight: 500, cursor: 'pointer', marginBottom: 14 }}
            >
              Continue with Google
            </button>

            <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                type="email"
                required
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ padding: '11px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(0,0,0,0.25)', color: '#fff', fontSize: 14 }}
              />
              <input
                type="password"
                required
                minLength={8}
                placeholder="Password (min 8 chars)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ padding: '11px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(0,0,0,0.25)', color: '#fff', fontSize: 14 }}
              />
              <button
                type="submit"
                disabled={busy}
                style={{ padding: '11px 16px', borderRadius: 12, border: 0, background: '#fff', color: '#111', fontWeight: 600, cursor: 'pointer', marginTop: 4 }}
              >
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            {error && <p style={{ color: '#fca5a5', fontSize: 13, marginTop: 12 }}>{error}</p>}
            {notice && <p style={{ color: '#86efac', fontSize: 13, marginTop: 12 }}>{notice}</p>}

            <button
              type="button"
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setNotice(''); }}
              style={{ marginTop: 16, background: 'none', border: 0, color: '#cbd5e1', fontSize: 13, cursor: 'pointer', padding: 0 }}
            >
              {mode === 'login' ? 'Need a Dot ID? Create one' : 'Already have a Dot ID? Sign in'}
            </button>
          </>
        )}
      </section>
    </main>
  );
}

export default function DotAuthPage() {
  return (
    <Suspense fallback={null}>
      <DotAuthInner />
    </Suspense>
  );
}
