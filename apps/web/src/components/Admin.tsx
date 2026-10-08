import type { TokenTest, Vault } from '@karpathy/shared';
import { useEffect, useState } from 'react';
import { api, ApiError, errorText } from '../lib/api';
import { useApp } from '../store';
import { Modal } from './Dialogs';
import { Icon } from './Icon';
import { InstagramNotice, InstagramSettings } from './InstagramSettings';

interface Form { name: string; repo: string; branch: string; root: string }
const emptyForm: Form = { name: '', repo: '', branch: 'main', root: '' };

/** The modal's views; there is no router, the view is modal-internal state. */
type View = { kind: 'list' } | { kind: 'details'; id: string } | { kind: 'add' };

function VaultFields({ f, set, prefix }: { f: Form; set(f: Form): void; prefix: string }) {
  const field = (k: keyof Form, label: string, placeholder: string) => (
    <label className="field">
      <span>{label}</span>
      <input data-testid={`${prefix}-${k}`} value={f[k]} placeholder={placeholder} autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={(e) => set({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <>
      {field('name', 'Name', 'My wiki')}
      {field('repo', 'GitHub repo', 'owner/name')}
      {field('branch', 'Branch', 'main')}
      {field('root', 'Vault root (optional)', 'subfolder, empty = repo root')}
    </>
  );
}

const where = (v: Vault) => `${v.repo} · ${v.branch}${v.root ? ` · /${v.root}` : ''}`;

function VaultRow({ v, open }: { v: Vault; open(): void }) {
  return (
    <button className="vrow vrow-btn" data-testid="admin-vault" data-vault={v.id} data-state={v.state} onClick={open}>
      <div className="vrow-h">
        <div className="nm"><b>{v.name}</b><small>{where(v)}</small></div>
        <span className={`state s-${v.state}`}>{v.state}</span>
        <Icon n="chevron_right" size={16} />
      </div>
    </button>
  );
}

function VaultDetails({ v, back }: { v: Vault; back(): void }) {
  const { reloadVaults, toast, forgetVault } = useApp();
  const [edit, setEdit] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const save = async () => {
    if (!edit) return;
    const patch: Partial<Form> = {};
    for (const k of ['name', 'repo', 'branch', 'root'] as const) if (edit[k].trim() !== v[k]) patch[k] = edit[k].trim();
    try {
      if (Object.keys(patch).length) await api.patchVault(v.id, patch);
      setEdit(null);
      setError(null);
      await reloadVaults();
    } catch (e) { setError(errorText(e)); }
  };
  const remove = async () => {
    if (!confirm(`Remove vault “${v.name}”? This deletes the local clone only, never the GitHub repo.`)) return;
    setError(null);
    setRemoving(true);
    try { await api.removeVault(v.id); forgetVault(v.id); toast(`Removed ${v.name}`); await reloadVaults(); back(); } catch (e) { setError(errorText(e)); }
    finally { setRemoving(false); }
  };
  /** A PATCH without changes re-runs a failed clone (issue #23). */
  const retry = async () => {
    try { await api.patchVault(v.id, {}); setError(null); await reloadVaults(); } catch (e) { setError(errorText(e)); }
  };
  return (
    <div className="vrow" data-testid="vault-details" data-vault={v.id} data-state={v.state}>
      <div className="vrow-h">
        <div className="nm"><b>{v.name}</b><small>{where(v)}</small></div>
        <span className={`state s-${v.state}`}>{v.state}</span>
      </div>
      {v.state === 'clone-failed' && v.error && <div className="form-error">{v.error}</div>}
      {edit ? (
        <div className="form">
          <VaultFields f={edit} set={setEdit} prefix="edit" />
          <div className="acts"><button className="btn g" onClick={() => { setEdit(null); setError(null); }}>Cancel</button><button className="btn" data-testid="edit-save" onClick={() => void save()}>Save</button></div>
        </div>
      ) : (
        <div className="acts">
          {v.state === 'clone-failed' && <button className="btn g" data-testid="vault-retry" onClick={() => void retry()}>Retry</button>}
          <button className="btn g" data-testid="vault-edit" onClick={() => setEdit({ name: v.name, repo: v.repo, branch: v.branch, root: v.root })}>Edit</button>
          <button className="btn g danger" data-testid="vault-remove" disabled={removing} onClick={() => void remove()}>{removing ? 'Waiting for the vault to be free…' : 'Remove'}</button>
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}

function AddVault({ done }: { done(): void }) {
  const { reloadVaults, setActiveId, activeId } = useApp();
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Required folders the repo lacks; set while the user decides whether to create them. */
  const [missing, setMissing] = useState<string[] | null>(null);
  const add = async (createFolders = false) => {
    setBusy(true);
    try {
      const v = await api.addVault({ name: form.name.trim(), repo: form.repo.trim(), branch: form.branch.trim() || 'main', root: form.root.trim(), ...(createFolders ? { createFolders } : {}) });
      setMissing(null);
      setError(null);
      await reloadVaults();
      if (!activeId) void setActiveId(v.id);
      done();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'missing-folders') setMissing(err.body.missing as string[]);
      else setError(errorText(err));
    } finally { setBusy(false); }
  };
  return (
    <>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <VaultFields f={form} set={setForm} prefix="admin" />
        {error && <div className="form-error" role="alert" data-testid="admin-error">{error}</div>}
        <div className="acts"><button className="btn" data-testid="admin-add" disabled={busy || !form.repo.trim()}>{busy ? 'Checking the repo…' : 'Add vault'}</button></div>
      </form>
      {missing && (
        <Modal title="Create folders?" onClose={() => setMissing(null)} testid="missing-folders">
          <p>
            <b>{form.repo.trim()}</b> has no {missing.map((f, i) => <span key={f}>{i ? ' and ' : ''}<code>{f}/</code></span>)} folder. Create {missing.length > 1 ? 'them' : 'it'}?
          </p>
          <p className="muted">They’ll appear as uncommitted changes until you commit. Without them, the vault is not attached.</p>
          <div className="acts">
            <button className="btn g" data-testid="folders-cancel" onClick={() => setMissing(null)}>Don’t attach</button>
            <button className="btn" data-testid="folders-create" disabled={busy} onClick={() => void add(true)}>{busy ? 'Adding…' : 'Create folders'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function SettingsForm() {
  const { settings, setSettings, toast } = useApp();
  const [threshold, setThreshold] = useState('');
  const [model, setModel] = useState('');
  const [webAccess, setWebAccess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings) { setThreshold(String(settings.commitReminderThreshold)); setModel(settings.model); setWebAccess(settings.webAccess); }
  }, [settings]);
  const edit = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { set(e.target.value); setSaved(false); };
  const save = async () => {
    setSaved(false);
    const n = Number(threshold);
    if (!/^\d+$/.test(threshold.trim()) || n < 1 || n > 1000) return setError('Commit reminder: enter a whole number between 1 and 1000.');
    if (!model.trim()) return setError('Model: enter provider/model, or use the default.');
    setBusy(true);
    try {
      setSettings(await api.patchSettings({ commitReminderThreshold: n, model: model.trim(), webAccess }));
      setError(null);
      setSaved(true);
      toast('Settings saved');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="form">
      <label className="field"><span>Commit reminder after (changed files)</span>
        <input data-testid="settings-threshold" type="number" min={1} max={1000} step={1} value={threshold} onChange={edit(setThreshold)} /></label>
      <label className="field"><span>Model (server-wide, provider/model)</span>
        <input data-testid="settings-model" value={model} autoCapitalize="off" spellCheck={false} onChange={edit(setModel)} /></label>
      {settings && (
        <div className="model-default">
          <span className="muted" data-testid="settings-model-default" data-overridden={String(settings.modelOverridden)}>Default: {settings.defaultModel}</span>
          {model.trim() !== settings.defaultModel && (
            <button type="button" className="btn g sm" data-testid="settings-model-reset" onClick={() => { setModel(settings.defaultModel); setSaved(false); }}>Use default</button>
          )}
        </div>
      )}
      <div className="switch-row">
        <div>
          <label htmlFor="settings-web-access">Web access</label>
          <p className="muted">Lets the AI search the web (via Exa) and read pages you or it found. Each search and page is shown in the chat.</p>
        </div>
        <input id="settings-web-access" className="switch" data-testid="settings-web-access" type="checkbox" role="switch" checked={webAccess}
          onChange={(e) => { setWebAccess(e.target.checked); setSaved(false); }} />
      </div>
      <p className="muted">Provider keys live on the server only; the app never sees them.</p>
      {error && <div className="form-error" role="alert" data-testid="settings-error">{error}</div>}
      <div className="acts">
        {saved && <span className="saved" role="status" data-testid="settings-saved"><Icon n="checkmark" size={15} />Saved</span>}
        <button className="btn" data-testid="settings-save" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </div>
  );
}

/** The one server-wide GitHub token: set, replace or remove it, and test it before or after saving. */
function GitHubTokenForm() {
  const { settings, setSettings, toast } = useApp();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'remove' | 'test'>(null);
  const [result, setResult] = useState<TokenTest | null>(null);
  const t = settings?.githubToken;
  const placeholder = !t || t.source === 'none' ? 'No token set' : t.source === 'secret' ? `Using the server’s token •••• ${t.last4}` : `•••• ${t.last4}`;
  const run = async (kind: 'save' | 'remove' | 'test', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  const save = () => run('save', async () => {
    await api.putGithubToken(token.trim());
    setToken('');
    setResult(null);
    setSettings(await api.settings());
    toast('GitHub token saved');
  });
  const remove = () => run('remove', async () => {
    await api.removeGithubToken();
    setResult(null);
    setSettings(await api.settings());
    toast('GitHub token removed');
  });
  const test = () => run('test', async () => { setResult(await api.testGithubToken(token.trim() || undefined)); });
  const expires = result?.expiresAt ? `, expires ${result.expiresAt.slice(0, 10)}` : '';
  return (
    <div className="form">
      <label className="field"><span>GitHub token (used for every vault)</span>
        <input data-testid="token-input" type="password" value={token} placeholder={placeholder} autoComplete="off" autoCapitalize="off" spellCheck={false}
          onChange={(e) => { setToken(e.target.value); setResult(null); }} /></label>
      <p className="muted">Needs read and write access to the vaults’ repos. It stays on the server; the app only shows its last 4 characters.</p>
      {error && <div className="form-error" role="alert" data-testid="token-error">{error}</div>}
      {result && (
        <div className="token-result" role="status" data-testid="token-result" data-ok={result.ok}>
          <div className={result.ok ? 'ok' : 'bad'}>
            <Icon n={result.ok ? 'checkmark' : 'xmark'} size={15} />
            {result.ok ? <>Works — signed in as <b>{result.login}</b>{expires}</> : result.error}
          </div>
          {result.vaults.map((v) => (
            <div key={v.id} className={v.ok ? 'ok' : 'bad'} data-testid="token-vault" data-vault={v.id} data-ok={v.ok}>
              <Icon n={v.ok ? 'checkmark' : 'xmark'} size={15} />{v.ok ? v.repo : v.error}
            </div>
          ))}
        </div>
      )}
      <div className="acts">
        {t?.source === 'settings' && <button className="btn g danger" data-testid="token-remove" disabled={!!busy} onClick={() => void remove()}>{busy === 'remove' ? 'Removing…' : 'Remove'}</button>}
        <button className="btn g" data-testid="token-test" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test token'}</button>
        <button className="btn" data-testid="token-save" disabled={!!busy || token.trim().length === 0} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save token'}</button>
      </div>
    </div>
  );
}

/** ISO timestamp → local `YYYY-MM-DD HH:MM`. */
function localTime(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Server and PWA version: after a deploy, shows whether the new release and its service worker are live.
 *  Built and Deployed come from the server; local builds have neither. */
function Versions() {
  const [server, setServer] = useState('…');
  const [times, setTimes] = useState<{ built: string | null; deployed: string | null }>({ built: null, deployed: null });
  useEffect(() => {
    api.health().then((h) => { setServer(h.version); setTimes({ built: h.built, deployed: h.deployed }); }, () => setServer('unreachable'));
  }, []);
  return (
    <p className="muted">
      Server <span data-testid="version-server">{server}</span> · App <span data-testid="version-pwa">{__APP_VERSION__}</span>
      {times.built && <> · Built <span data-testid="version-built">{localTime(times.built)}</span></>}
      {times.deployed && <> · Deployed <span data-testid="version-deployed">{localTime(times.deployed)}</span></>}
    </p>
  );
}

/** "What is a vault?": the structure the app expects in a vault root. */
function VaultHelp({ close }: { close(): void }) {
  return (
    <Modal title="What is a vault?" onClose={close} testid="vault-help">
      <p>A vault is a GitHub repo (or a folder in it) holding Markdown notes. The AI keeps it as a wiki built from your sources:</p>
      <pre className="tree-sketch">{'my-vault/\n├── Sources/   immutable source documents\n├── Wiki/      the knowledge base the AI maintains\n└── Schema/    optional: instructions for the AI'}</pre>
      <p><b><code>Sources/</code></b> holds what you collect: articles, mails, PDFs, clips. Sources are added, not rewritten.</p>
      <p><b><code>Wiki/</code></b> holds the pages the AI writes from them: entities, concepts, topics, summaries, an index and a log.</p>
      <p><b><code>Schema/</code></b> is optional and holds instructions for the AI, e.g. <code>Schema/CLAUDE.md</code>.</p>
      <p className="muted">When you add a repo without <code>Sources/</code> or <code>Wiki/</code>, the app offers to create them.</p>
    </Modal>
  );
}

export function Admin() {
  const { adminOpen } = useApp();
  return adminOpen && adminOpen.view === 'settings' ? <SettingsDialog /> : <VaultsDialog />;
}

function SettingsDialog() {
  const { setAdminOpen } = useApp();
  return (
    <Modal title="Settings" onClose={() => setAdminOpen(false)} wide testid="settings-dialog" focusTitle>
      <div className="gh">GitHub</div>
      <GitHubTokenForm />
      <div className="gh">Instagram</div>
      <InstagramSettings />
      <div className="gh">App</div>
      <SettingsForm />
      <div className="gh">Version</div>
      <Versions />
    </Modal>
  );
}

function VaultsDialog() {
  const { vaults, reloadVaults, setAdminOpen, adminOpen } = useApp();
  const start = adminOpen && adminOpen.view === 'vaults' ? adminOpen.vault : undefined;
  const [view, setView] = useState<View>(start ? { kind: 'details', id: start } : { kind: 'list' });
  const [help, setHelp] = useState(false);
  useEffect(() => { void reloadVaults(); }, [reloadVaults]);
  const list = () => setView({ kind: 'list' });
  const current = view.kind === 'details' ? vaults?.find((v) => v.id === view.id) : undefined;
  const title = view.kind === 'details' ? (current?.name ?? 'Vault') : view.kind === 'add' ? 'Add vault' : 'Vaults';
  return (
    // Focus starts on the title, not on a field (issue #39).
    <Modal title={title} onClose={() => setAdminOpen(false)} wide testid="admin" focusTitle>
      {view.kind !== 'list' && (
        <button className="link back" data-testid="admin-back" onClick={list}><Icon n="chevron_left" size={15} />All vaults</button>
      )}
      {view.kind === 'list' && (
        <>
          <div className="gh">
            Vaults
            <button className="ib help" data-testid="admin-help" aria-label="What is a vault?" title="What is a vault?" onClick={() => setHelp(true)}><Icon n="question_circle" size={18} /></button>
          </div>
          <InstagramNotice open={() => setAdminOpen('settings')} />
          {vaults?.length === 0 && <p className="muted">No vaults yet. Each vault is an existing GitHub repo.</p>}
          {vaults?.map((v) => <VaultRow key={v.id} v={v} open={() => setView({ kind: 'details', id: v.id })} />)}
          <div className="acts">
            <button className="btn" data-testid="admin-open-add" onClick={() => setView({ kind: 'add' })}>Add vault</button>
          </div>
        </>
      )}
      {view.kind === 'details' && (current ? <VaultDetails v={current} back={list} /> : vaults && <p className="muted">This vault no longer exists.</p>)}
      {view.kind === 'add' && <AddVault done={list} />}
      {help && <VaultHelp close={() => setHelp(false)} />}
    </Modal>
  );
}
