import type { InstagramLoginAnswer, InstagramStatus, InstagramWorker, InstagramWorkerState } from '@karpathy/shared';
import { useEffect, useState } from 'react';
import { api, ApiError, errorText } from '../lib/api';
import { Icon } from './Icon';

/** "N links waiting": Instagram links in the vaults' Input/ that wait for a session. */
const linksWaiting = (n = 0) => `${n} link${n === 1 ? '' : 's'} waiting`;

export const WORKER_GUIDE = 'https://github.com/tillg/karpathy.app/blob/main/docs/instagram-worker.md';
const HOUR_MS = 3_600_000;

/** Worker mode: Instagram workers on the user's machines scrape, not the server. */
const workerMode = (s: InstagramStatus) => s.source === 'worker';
const seenWithinHour = (w: InstagramWorker, now = Date.now()) => now - Date.parse(w.lastSeen) <= HOUR_MS;

/** "just now", "3 min ago", "2 h ago", "4 d ago". */
function seenAgo(iso: string, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / (24 * 60))} d ago`;
}

/** A worker's state as a status pill: label and tone (the `.status` classes). */
const WORKER_STATE: Record<InstagramWorkerState, [string, 'ok' | 'warn' | 'bad' | 'off']> = {
  idle: ['Idle', 'ok'],
  scraping: ['Scraping', 'ok'],
  night: ['Night', 'off'],
  resting: ['Resting', 'off'],
  'needs-login': ['Needs login', 'warn'],
  'rate-limited': ['Rate-limited', 'warn'],
  error: ['Error', 'bad'],
};

/** The status line: who is connected, or why not; plus the Instagram links that wait for a session. */
function statusText(s: InstagramStatus): string {
  const waiting = s.waitingLinks ? ` — ${linksWaiting(s.waitingLinks)}` : '';
  if (workerMode(s)) return `Scraped by your worker${s.workers?.length === 1 ? '' : 's'}${waiting}`;
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
  if (workerMode(status)) return <WorkerPanel status={status} />;
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

/**
 * Worker mode: the workers that scrape for the server (instead of the Connect form), what each last reported, the
 * job counts, a warning when two workers share the work (one Instagram account per worker) and the setup guide.
 */
function WorkerPanel({ status }: { status: InstagramStatus }) {
  const workers = status.workers ?? [];
  const q = status.queue;
  const now = Date.now();
  const needLogin = workers.filter((w) => w.state === 'needs-login');
  return (
    <div className="form">
      <p data-testid="ig-status" data-state={status.state} data-source="worker">{statusText(status)}</p>
      <div className="srv-list" data-testid="ig-workers">
        {workers.length === 0 && (
          <div className="srv-li"><Icon n="desktopcomputer" size={20} /><span className="tx muted">No worker has reported yet.</span></div>
        )}
        {workers.map((w) => {
          const [label, tone] = WORKER_STATE[w.state] ?? [w.state, 'off'];
          return (
            <div className="srv-li" key={w.name} data-testid="ig-worker" data-name={w.name}>
              <Icon n="desktopcomputer" size={20} />
              <div className="tx">
                <b>{w.name}</b>
                <p className="muted">last seen {seenAgo(w.lastSeen, now)}{w.message ? ` — ${w.message}` : ''}</p>
              </div>
              <span className={`status ${tone}`}>{label}</span>
            </div>
          );
        })}
      </div>
      {needLogin.map((w) => (
        <div className="banner warn" key={w.name} data-testid="ig-login-hint">
          Run <code>karpathy-instagram-worker login</code> on <span className="nowrap">{w.name}</span>.
        </div>
      ))}
      {q && (
        <p className="muted" data-testid="ig-queue">
          {q.waiting} waiting · {q.leased} in progress · {q.backingOff} backing off · {q.failed} failed
        </p>
      )}
      {workers.filter((w) => seenWithinHour(w, now)).length >= 2 && (
        <div className="banner warn" data-testid="ig-two-workers">
          Two or more workers were active in the last hour. Use one Instagram account per worker, or Instagram may block them.
        </div>
      )}
      <p><a href={WORKER_GUIDE} target="_blank" rel="noreferrer" data-testid="ig-guide">Set up a worker</a></p>
    </div>
  );
}

/** The Vaults-list notice for a status, or null: what keeps Instagram links from being fetched. */
function noticeText(s: InstagramStatus): { text: string; act: string } | null {
  if (workerMode(s)) {
    const needLogin = (s.workers ?? []).find((w) => w.state === 'needs-login');
    if (needLogin) return { text: `Instagram needs a login on ${needLogin.name}.`, act: 'Details in Secrets & keys' };
    const n = s.waitingLinks ?? 0;
    if (n > 0 && !(s.workers ?? []).some((w) => seenWithinHour(w)))
      return { text: `${n} Instagram link${n === 1 ? ' waits' : 's wait'} for a worker — none was seen in the last hour.`, act: 'Workers in Secrets & keys' };
    return null;
  }
  if (s.state === 'expired') return { text: `Instagram disconnected — ${linksWaiting(s.waitingLinks)}.`, act: 'Reconnect in Secrets & keys' };
  return null;
}

/**
 * Vaults section: a notice when Instagram links can't be fetched: the session expired (local mode), or no worker was
 * seen for an hour while links wait, or a worker needs a login (worker mode).
 */
export function InstagramNotice({ open }: { open(): void }) {
  const [s, setS] = useState<InstagramStatus | null>(null);
  useEffect(() => { api.instagram().then(setS).catch(() => setS(null)); }, []);
  const n = s && noticeText(s);
  if (!n) return null;
  return (
    <div className="banner warn" data-testid="ig-notice">
      {n.text}{' '}
      <button className="link" data-testid="ig-notice-open" onClick={open}>{n.act}</button>
    </div>
  );
}
