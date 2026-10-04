import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { incomingView } from '../lib/incoming';
import { useApp } from '../store';
import { Admin } from './Admin';
import { ChatPane } from './ChatPane';
import { CommitDialog } from './CommitDialog';
import { ReminderDialog, StaleDialog, Toast } from './Dialogs';
import { Icon } from './Icon';
import { NotePane } from './NotePane';
import { Sidebar } from './Sidebar';

const TABS = [
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'chat', label: 'Chat', icon: 'bubble_left' },
  { id: 'changes', label: 'Changes', icon: 'arrow_2_circlepath' },
] as const;

export function Shell() {
  const s = useApp();
  const { phone, wide, phoneTab, phoneNote, status } = s;
  const inc = incomingView(status, s.pulling);
  const cls = [
    phone ? 'phone' : wide ? 'wide' : 'tablet',
    s.chatOpen && !phone ? 'insp' : '',
    s.sidebarOpen && !phone ? 'sbopen' : '',
    s.chatMain ? 'chatmain' : '',
  ].join(' ');
  // Phone: push navigation. The tab root is "cur"; an open note is pushed over it.
  const pos = (id: 'sidebar' | 'detail' | 'chat') => {
    if (!phone) return undefined;
    if (phoneTab === 'chat') return id === 'chat' ? 'cur' : 'off';
    if (id === 'chat') return 'off';
    if (id === 'sidebar') return phoneNote ? 'behind' : 'cur';
    return phoneNote ? 'cur' : 'ahead';
  };
  // Off-screen/covered panes are inert, so Tab and screen readers skip them (issue #26).
  const tablet = !phone && !wide;
  const inert = (id: 'sidebar' | 'detail' | 'chat') => {
    if (phone) return pos(id) !== 'cur';
    if (!tablet) return false;
    if (id === 'sidebar') return !s.sidebarOpen;
    if (id === 'chat') return !s.chatOpen;
    return s.sidebarOpen || s.chatOpen;
  };
  // Tablet: Escape closes the overlay sidebar / chat and returns focus to its toggle (issue #43).
  const overlay = tablet && (s.sidebarOpen || s.chatOpen);
  const { setSidebarOpen, setChatOpen, sidebarOpen } = s;
  useEffect(() => {
    if (!overlay) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const toggle = sidebarOpen ? 'sidebar-toggle' : 'chat-toggle';
      flushSync(() => { setSidebarOpen(false); setChatOpen(false); });
      document.querySelector<HTMLElement>(`[data-testid="${toggle}"]`)?.focus();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [overlay, sidebarOpen, setSidebarOpen, setChatOpen]);

  // Tablet: an opened overlay takes focus (its toggle is now behind the scrim, #50).
  const { chatOpen } = s;
  useEffect(() => {
    if (!tablet || (!sidebarOpen && !chatOpen)) return;
    const pane = document.getElementById(sidebarOpen ? 'sidebar' : 'chat');
    if (pane && !pane.contains(document.activeElement))
      pane.querySelector<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')?.focus();
  }, [tablet, sidebarOpen, chatOpen]);

  // Wide layout: the swap button on the note/chat divider says what a click does.
  const swapLabel = s.chatMain ? 'Move note to main column' : 'Move chat to main column';

  return (
    <>
      {/* Page heading + banner landmark for screen readers (issue #47); the panes are main/aside. */}
      <header className="sr-only"><h1>karpathy.app{s.active ? ` — ${s.active.name}` : ''}</h1></header>
      <div id="app" className={cls} data-sb={pos('sidebar')} data-dt={pos('detail')} data-ch={pos('chat')}>
        <Sidebar inert={inert('sidebar')} />
        <NotePane inert={inert('detail')} />
        <ChatPane inert={inert('chat')} />
        {wide && s.chatOpen && (
          <button id="main-swap" data-testid="main-swap" aria-pressed={s.chatMain} title={swapLabel} aria-label={swapLabel}
            onClick={() => s.setChatMain(!s.chatMain)}><Icon n="arrow_right_arrow_left" size={16} /></button>
        )}
        {phone && (
          <nav id="tabbar" aria-label="Tabs">
            {TABS.map((t) => (
              <button key={t.id} className={phoneTab === t.id ? 'on' : ''} aria-current={phoneTab === t.id ? 'page' : undefined} data-testid={`tab-${t.id}`}
                onClick={() => { if (phoneTab === t.id) s.setPhoneNote(false); s.setPhoneTab(t.id); }}>
                <span className="tab-ic"><Icon n={t.icon} size={25} />
                  {t.id === 'changes' && (status?.changedCount || inc.tabMark)
                    ? <span className="tab-badge" data-testid="changes-badge-tab">{[status?.changedCount || '', inc.tabMark ? '↓' : ''].filter(Boolean).join(' ')}</span>
                    : null}
                  {t.id === 'changes' && inc.tabMark && <span className="sr-only"> · {inc.count} incoming</span>}
                </span>
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <div id="scrim" className={!phone && !wide && (s.sidebarOpen || s.chatOpen) ? 'on' : ''}
          onClick={() => { s.setSidebarOpen(false); s.setChatOpen(false); }} />
      </div>
      {s.adminOpen && <Admin />}
      {s.commitOpen && <CommitDialog />}
      <StaleDialog />
      <ReminderDialog />
      <Toast />
    </>
  );
}
