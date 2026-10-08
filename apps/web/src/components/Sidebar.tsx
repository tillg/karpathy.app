import { useApp, type Section } from '../store';
import { ChangesPanel } from './ChangesPanel';
import { FileTree } from './FileTree';
import { GitPill } from './GitPill';
import { Icon } from './Icon';
import { SearchPanel } from './SearchPanel';
import { VaultSwitcher } from './VaultSwitcher';

const TITLES: Record<Section, string> = { files: 'Files', search: 'Search', changes: 'Changes' };

/** Sidebar column (desktop), overlay (tablet), or the Files/Search/Changes tab root (phone). */
export function Sidebar({ inert }: { inert?: boolean }) {
  const { section, setSection, phone, phoneTab, setAdminOpen, setSidebarOpen, wide, status, usable, setGraphOpen } = useApp();
  const current: Section = phone ? (phoneTab === 'chat' ? 'files' : phoneTab) : section;
  return (
    <aside className="pane" id="sidebar" inert={inert} aria-label="Sidebar">
      <header className="bar">
        {phone && <span className="bar-title">{TITLES[current]}</span>}
        <span className="sp" />
        <button className="ib" title="Graph" aria-label="Graph" data-testid="open-graph" disabled={!usable} onClick={() => setGraphOpen(true)}><Icon n="circle_grid_hex" /></button>
        <button className="ib" title="Settings" aria-label="Settings" data-testid="open-settings" onClick={() => setAdminOpen('settings')}><Icon n="gear_alt" /></button>
        {!wide && !phone && <button className="ib" title="Close sidebar" onClick={() => setSidebarOpen(false)}><Icon n="sidebar_left" /></button>}
      </header>
      <div className="scroll">
        <VaultSwitcher />
        {/* Below the vault switcher: the sections are scoped to the vault (#125). */}
        {!phone && (
          <div className="seg full" data-testid="sidebar-sections">
            {(['files', 'search', 'changes'] as const).map((s) => (
              <button key={s} className={section === s ? 'on' : ''} aria-pressed={section === s} data-testid={`section-${s}`} onClick={() => setSection(s)}>
                {TITLES[s]}{s === 'changes' && status?.changedCount ? <span className="count">{status.changedCount}</span> : null}
              </button>
            ))}
          </div>
        )}
        {current === 'files' && <FileTree />}
        {current === 'search' && <SearchPanel />}
        {current === 'changes' && <ChangesPanel />}
      </div>
      {!phone && <div className="sbfoot"><GitPill /></div>}
    </aside>
  );
}
