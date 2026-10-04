import { incomingView } from '../lib/incoming';
import { useApp } from '../store';

/** Changed-files count, always visible; opens Show changes. Incoming changes: a joined segment that pulls. */
export function GitPill({ small }: { small?: boolean }) {
  const { status, setSection, setSidebarOpen, setPhoneTab, setPhoneNote, phone, pull, pulling } = useApp();
  if (!status) return null;
  const inc = incomingView(status, pulling);
  const n = status.changedCount;
  const busy = status.busy === 'sync' ? 'Syncing…' : status.busy === 'turn' ? 'AI working…' : null;
  const cls = status.state === 'conflict' ? 'conflict' : busy ? 'busy' : n ? 'dirty' : '';
  const text = status.state === 'conflict' ? 'Conflict' : busy ?? (n ? `${n} uncommitted` : 'All committed');
  return (
    <span className="gitpill-group">
      <button className={`gitpill ${cls}${small ? ' small' : ''}`} data-testid="changes-badge" data-count={n}
        title={status.pullError ? `Last pull from GitHub failed: ${status.pullError}` : undefined}
        onClick={() => { setSection('changes'); setSidebarOpen(true); if (phone) { setPhoneTab('changes'); setPhoneNote(false); } }}>
        <span className="dot" />{text}{status.unpushedCount ? ` · ${status.unpushedCount} unpushed` : ''}{status.pullError ? ' · offline' : ''}
      </button>
      {inc.show && (
        // A sibling, not nested: a button inside a button is invalid, and the pill's click must keep opening Changes.
        <button className={`gitpill-incoming${small ? ' small' : ''}`} data-testid="incoming-badge" data-count={inc.count}
          disabled={inc.disabled} aria-label={inc.label} title={inc.title} onClick={() => void pull()}>
          · {inc.count} incoming
        </button>
      )}
    </span>
  );
}
