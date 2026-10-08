import type { InstagramLoginAnswer, InstagramStatus } from '@karpathy/shared';
import { useEffect, useState } from 'react';
import { api, ApiError, errorText } from '../lib/api';

/** "N links waiting": Instagram links in the vaults' Input/ that wait for a session. */
const linksWaiting = (n = 0) => `${n} link${n === 1 ? '' : 's'} waiting`;

/** The status line: who is connected, or why not; plus the Instagram links that wait for a session. */
function statusText(s: InstagramStatus): string {
  const waiting = s.waitingLinks ? ` — ${linksWaiting(s.waitingLinks)}` : '';
  switch (s.state) {
    case 'connected': return `Connected as @${s.account}${waiting}`;
    case 'expired': return `Expired: Instagram rejected the session of @${s.account}${waiting}`;
    case 'waiting-for-code': return 'Waiting for the code';
    default: return `Not connected${waiting}`;
  }
}

/**
 * Admin › Instagram: the ingest service logs in to Instagram for fetching posts. Username and password go to the
 * server once (never stored); if Instagram asks for a 2FA or challenge code, a code field follows.
 */
export function InstagramSettings() {
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [via, setVia] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const s = await api.instagram();
      setStatus(s);
      setDown(null);
      if (s.state === 'waiting-for-code') setVia(s.via ?? null);
    } catch (e) {
      setDown(e instanceof ApiError && e.status === 503 ? e.message : errorText(e));
    }
  };
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const answered = async (r: InstagramLoginAnswer) => {
    if (r.state === 'code') { setVia(r.via ?? null); return; }
    setVia(null);
    setCode('');
    await load();
  };
  const connect = () => run(async () => {
    const pw = password;
    setPassword('');
    await answered(await api.instagramLogin(username.trim().replace(/^@/, ''), pw));
  });
  const verify = () => run(async () => { await answered(await api.instagramCode(code.trim())); });
  const disconnect = () => run(async () => { setStatus(await api.instagramDisconnect()); });

  if (down) return <div className="form"><p className="muted" data-testid="ig-status">{down}</p></div>;
  if (!status) return <div className="form"><p className="muted">Loading…</p></div>;
  const connected = status.state === 'connected';
  return (
    <div className="form">
      <p data-testid="ig-status" data-state={status.state}>{statusText(status)}</p>
      {via !== null ? (
        <>
          <p className="muted" data-testid="ig-code-hint">{via ? `Code sent by ${via}` : 'Instagram asks for a code'}</p>
          <label className="field"><span>Code</span>
            <input data-testid="ig-code" value={code} inputMode="numeric" autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} /></label>
          {error && <div className="form-error" role="alert" data-testid="ig-error">{error}</div>}
          <div className="acts">
            <button className="btn g" disabled={busy} onClick={() => { setVia(null); setError(null); }}>Cancel</button>
            <button className="btn" data-testid="ig-verify" disabled={busy || !code.trim()} onClick={() => void verify()}>{busy ? 'Verifying…' : 'Verify'}</button>
          </div>
        </>
      ) : connected ? (
        <div className="acts">
          <button className="btn g danger" data-testid="ig-disconnect" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
        </div>
      ) : (
        <>
          <label className="field"><span>Instagram username</span>
            <input data-testid="ig-username" value={username} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="username"
              onChange={(e) => setUsername(e.target.value)} /></label>
          <label className="field"><span>Password</span>
            <input data-testid="ig-password" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} /></label>
          <p className="muted">The server logs in once and keeps only the session; the password is not stored.</p>
          {error && <div className="form-error" role="alert" data-testid="ig-error">{error}</div>}
          <div className="acts">
            <button className="btn" data-testid="ig-connect" disabled={busy || !username.trim() || !password}
              onClick={() => void connect()}>{busy ? 'Connecting…' : status.state === 'expired' ? 'Reconnect' : 'Connect'}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Vaults dialog: a notice when Instagram links wait because the session expired. */
export function InstagramNotice({ open }: { open(): void }) {
  const [s, setS] = useState<InstagramStatus | null>(null);
  useEffect(() => { api.instagram().then(setS).catch(() => setS(null)); }, []);
  if (s?.state !== 'expired') return null;
  return (
    <div className="banner warn" data-testid="ig-notice">
      Instagram disconnected — {linksWaiting(s.waitingLinks)}.{' '}
      <button className="link" data-testid="ig-notice-open" onClick={open}>Reconnect in Settings</button>
    </div>
  );
}
