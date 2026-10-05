import { incomingView } from '../lib/incoming';
import { useApp } from '../store';

/** The pull of incoming changes as a text link (Changes banner, open-note bar). */
export function PullLink({ idle, busy }: { idle: string; busy: string }) {
  const { status, pull, pulling } = useApp();
  const inc = incomingView(status, pulling);
  return (
    <button className="link" disabled={inc.disabled} aria-label={inc.label} title={inc.title} onClick={() => void pull()}>
      {pulling ? busy : idle}
    </button>
  );
}
