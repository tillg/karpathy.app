import { useEffect, useRef, useState } from 'react';
import type { SecretFinding } from '@karpathy/shared';
import { ApiError, api, errorText } from '../lib/api';
import { useApp } from '../store';
import { Modal } from './Dialogs';

const PROPOSAL_TIMEOUT_MS = 16_000;

export function CommitDialog() {
  const { activeId, flush, setCommitOpen, toast, setStatus, status } = useApp();
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<'saving' | 'proposing' | 'ready' | 'committing'>('saving');
  const [error, setError] = useState<string | null>(null);
  /** The changed files the proposal (and the user's review) is about (#33). */
  const [paths, setPaths] = useState<string[] | undefined>(undefined);
  /** Possible secrets the last attempt found (#141); "Commit anyway" sends back exactly these. */
  const [secrets, setSecrets] = useState<SecretFinding[] | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!activeId) return;
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), PROPOSAL_TIMEOUT_MS);
    (async () => {
      await flush(); // the pending autosave must land before the commit (mvp §2.4)
      if (c.signal.aborted) return;
      setPhase('proposing');
      setPaths((await api.changes(activeId).catch(() => null))?.map((x) => x.path));
      try {
        setMessage((await api.commitMessage(activeId, c.signal)).message);
      } catch {
        const n = status?.changedCount ?? 0;
        setMessage(`Update ${n} file${n === 1 ? '' : 's'}`);
      }
      setPhase('ready');
    })();
    return () => { clearTimeout(t); c.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // The field is disabled while the message is proposed; once it is ready, focus moves into it
  // unless the user has already moved on (issue #39).
  useEffect(() => {
    const f = field.current;
    if (phase === 'ready' && f && document.activeElement === f.closest('[role=dialog]')?.querySelector('h2')) f.focus();
  }, [phase]);

  const close = () => setCommitOpen(false);
  const commit = async (allowSecrets?: string[]) => {
    if (!activeId) return;
    setPhase('committing');
    setError(null);
    setSecrets(null);
    try {
      // Never commit without the typed text (mvp §2.4): a failed save (e.g. stale) stops here.
      if (!(await flush())) {
        setError('The open note could not be saved, so nothing was committed. Resolve the save problem first.');
        setPhase('ready');
        return;
      }
      const r = await api.commit(activeId, message, paths, allowSecrets);
      if (!r.commit) toast('Nothing to commit');
      else toast(r.pushed ? 'Committed and pushed to GitHub' : `Committed; push failed: ${r.pushError ?? 'unknown error'}`);
      setStatus(await api.status(activeId));
      close();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'secrets') setSecrets((e.body.findings as SecretFinding[] | undefined) ?? []);
      else if (e instanceof ApiError && e.code === 'changes-moved') {
        const now = (e.body.paths as string[] | undefined) ?? [];
        const added = now.filter((p) => !paths?.includes(p));
        setPaths(now);
        setError(`More changes arrived while waiting${added.length ? `: ${added.join(', ')}` : ''}. Check the message (it now covers ${now.length} file${now.length === 1 ? '' : 's'}), then commit again.`);
      } else setError(e instanceof ApiError && e.code === 'conflict' ? 'Pulling from GitHub ran into a conflict. Resolve it in Changes, then commit.' : errorText(e));
      setPhase('ready');
    }
  };

  return (
    <Modal title="Commit & Push" onClose={close} testid="commit-dialog">
      <p className="muted">Records all uncommitted changes of this vault and pushes them to GitHub.</p>
      <div className="ta-wrap">
        <textarea ref={field} data-testid="commit-message" aria-label="Commit message" rows={5} value={message} onChange={(e) => setMessage(e.target.value)}
          disabled={phase !== 'ready'} placeholder={phase === 'saving' ? 'Saving open note…' : 'Proposing a message…'} />
        {(phase === 'saving' || phase === 'proposing') && <span className="spin ta-spin" />}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {secrets && (
        <div className="form-error" role="alert" data-testid="commit-secrets">
          <p>Possible secret{secrets.length === 1 ? '' : 's'} in the changes, so nothing was committed:</p>
          <ul>
            {secrets.map((f) => (
              <li key={f.fingerprint}><code>{f.file}</code> line {f.line}: {f.rule} (<code>{f.masked}</code>)</li>
            ))}
          </ul>
          <p>Remove {secrets.length === 1 ? 'it' : 'them'} (edit or discard the file), or commit anyway if {secrets.length === 1 ? 'it is' : 'they are'} not secret. GitHub keeps everything you push.</p>
        </div>
      )}
      <div className="acts">
        <button className="btn g" onClick={close}>Cancel</button>
        {secrets && secrets.length > 0 && (
          <button className="btn g danger" data-testid="commit-anyway" disabled={phase !== 'ready' || !message.trim()}
            onClick={() => void commit(secrets.map((f) => f.fingerprint))}>Commit anyway</button>
        )}
        <button className="btn" data-testid="commit-submit" disabled={phase !== 'ready' || !message.trim()} onClick={() => void commit()}>
          {phase === 'committing' ? (status?.busy === 'turn' ? 'Waiting for AI turn…' : 'Committing…') : 'Commit & Push'}
        </button>
      </div>
    </Modal>
  );
}
