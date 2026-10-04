import type { VaultStatus } from '@karpathy/shared';

/**
 * State of every incoming-changes control (pill segment, Changes banner, open-note bar, phone tab
 * badge), so they can't drift apart. No pull during an AI turn: the turn pulls first anyway.
 */
export function incomingView(status: VaultStatus | null | undefined, pulling: boolean) {
  const k = status?.incomingCount ?? 0;
  const show = status?.state === 'ready' && k > 0;
  const s = k === 1 ? '' : 's';
  return {
    show,
    count: k,
    disabled: pulling || (status?.busy ?? 'none') !== 'none',
    label: `Pull ${k} incoming change${s} from GitHub`,
    title: status?.busy === 'turn' ? 'The AI is working; its turn pulls first.' : `${k} file${s} changed on GitHub. Tap to pull.`,
    tabMark: show,
    moreCount: show ? k - status!.incomingPaths.length : 0,
  };
}
