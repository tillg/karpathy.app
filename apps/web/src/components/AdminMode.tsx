import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { brandName } from '../lib/brand';
import { ADMIN_SECTIONS, formatAdminRoute, type AdminSection } from '../lib/route';
import { useApp } from '../store';
import { AiSection, GeneralSection, SecretsSection, VaultsSection } from './Admin';
import { Icon } from './Icon';
import { secretsSummary } from './SecretTable';

const SECTIONS: Record<AdminSection, { label: string; short?: string; icon: string; sub: string }> = {
  general: { label: 'General', icon: 'slider_horizontal_3', sub: 'Commit reminder, version' },
  vaults: { label: 'Vaults', icon: 'book', sub: 'Add, edit and remove vaults' },
  secrets: { label: 'Secrets & keys', short: 'Secrets', icon: 'lock_shield', sub: 'GitHub, Instagram, deployment secrets' },
  ai: { label: 'AI', icon: 'sparkles', sub: 'Model and web access' },
  usage: { label: 'Usage', icon: 'chart_bar', sub: 'Tokens by day, model and vault' },
  server: { label: 'Server', icon: 'speedometer', sub: 'CPU, memory, load and disk' },
};

/** Admin mode (#150): replaces the user-mode panes. Rail on wide screens and tablets, section list → section on the phone. */
export function AdminMode() {
  const { admin, phone, wide, setAdminSection, adminUp, closeAdmin, settings, vaults } = useApp();
  const [version, setVersion] = useState<string | null>(null);
  const section: AdminSection = admin || 'general';
  const list = phone && admin === '';
  const [secrets, setSecrets] = useState<string | null>(null);
  useEffect(() => {
    if (!list) return;
    api.health().then((h) => setVersion(h.version), () => {});
    api.secrets().then((r) => setSecrets(secretsSummary(r.secrets)), () => {});
  }, [list]);
  /** Phone list summaries: real data where it is at hand, else the static text. */
  const sub = (s: AdminSection) =>
    s === 'general' && version ? `version ${version}`
    : s === 'vaults' && vaults ? `${vaults.length} vault${vaults.length === 1 ? '' : 's'}`
    : s === 'secrets' && secrets ? secrets
    : s === 'ai' && settings ? `${settings.model.split('/').pop()} · web ${settings.webAccess ? 'on' : 'off'}`
    : SECTIONS[s].sub;

  // Wide and tablet: Escape leaves admin mode, like Done (a modal on top takes Escape first).
  useEffect(() => {
    if (phone) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      closeAdmin();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [phone, closeAdmin]);

  const go = (s: AdminSection) => (e: React.MouseEvent) => { e.preventDefault(); setAdminSection(s); };
  const done = <button className="ib txt" title="Back to your notes (Esc)" onClick={closeAdmin}>Done</button>;

  return (
    <div id="admin-mode" className={phone ? 'phone' : wide ? 'wide' : 'tablet'}>
      {!phone && (
        <nav className="admin-rail" aria-label="Admin sections">
          <div className="rail-h"><span className="nmx">{brandName(import.meta.env.VITE_STACK)}</span><span className="mode-pill">Admin</span></div>
          {ADMIN_SECTIONS.map((s) => (
            <a key={s} href={formatAdminRoute(s)} aria-current={s === section ? 'page' : undefined} data-testid={`admin-nav-${s}`} onClick={go(s)}>
              <Icon n={SECTIONS[s].icon} size={20} /><span className="l">{SECTIONS[s].label}</span><span className="s">{SECTIONS[s].short ?? SECTIONS[s].label}</span>
            </a>
          ))}
          <div className="sp" />
          <div className="who">Admin mode: settings for this installation, all vaults and all users.</div>
        </nav>
      )}
      <div className="admin-main">
        <header className="bar">
          {list ? <><span className="mode-pill">Admin</span><span className="sp" />{done}</>
            : phone ? <button className="ib back" onClick={adminUp}><Icon n="chevron_left" size={20} />Admin</button>
            : <><h1 className="bar-title">{SECTIONS[section].label}</h1><span className="sp" />{done}</>}
        </header>
        <main className="admin-content" aria-label="Admin">
          {list ? (
            <>
              <h1 className="lt">Admin</h1>
              <div className="admin-list">
                {ADMIN_SECTIONS.map((s) => (
                  <a key={s} href={formatAdminRoute(s)} data-testid={`admin-row-${s}`} onClick={go(s)}>
                    <Icon n={SECTIONS[s].icon} /><span className="tx"><b>{SECTIONS[s].label}</b><small>{sub(s)}</small></span><Icon n="chevron_right" size={16} />
                  </a>
                ))}
              </div>
              <p className="muted admin-note">Settings for this installation, all vaults and all users. Done goes back to your notes.</p>
            </>
          ) : (
            <div className="admin-inner" data-testid={`admin-section-${section}`}>
              {phone && <h1 className="lt">{SECTIONS[section].label}</h1>}
              {section === 'general' && <GeneralSection />}
              {section === 'vaults' && <VaultsSection />}
              {section === 'secrets' && <SecretsSection />}
              {section === 'ai' && <AiSection />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
