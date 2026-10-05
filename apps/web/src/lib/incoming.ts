import type { VaultStatus } from '@karpathy/shared';

/**
 * State of every incoming-changes control (pill segment, Changes banner, open-note bar, phone tab
 * badge), so they can't drift apart. No pull during an AI turn: the turn pulls first anyway.
 */
export function incomingView(status: VaultStatus | null | undefined, pulling: boolean) {
  const count = status?.incomingCount ?? 0;
  const show = status?.state === 'ready' && count > 0;
  const plural = count === 1 ? '' : 's';
  return {
    show,
    count,
    disabled: pulling || (status?.busy ?? 'none') !== 'none',
    label: `Pull ${count} incoming change${plural} from GitHub`,
    title: status?.busy === 'turn' ? 'The AI is working; its turn pulls first.' : `${count} file${plural} changed on GitHub. Tap to pull.`,
    moreCount: show ? count - status!.incomingPaths.length : 0,
  };
}
