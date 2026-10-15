import type { SecretStatus } from '@karpathy/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';

/** "N of M set" for the table heading and the phone section list. */
export const secretsSummary = (secrets: SecretStatus[]) => `${secrets.filter((x) => x.set).length} of ${secrets.length} set`;

function Pill({ s }: { s: SecretStatus }) {
  const [cls, icon, word] = s.set ? ['ok', 'checkmark_alt', 'Set'] : s.optional ? ['off', 'minus', 'Not set (optional)'] : ['bad', 'xmark', 'Missing'];
  return <span className={`status ${cls}`}><Icon n={icon} />{word}</span>;
}

/** Deployment secrets (#150): which ones are set, never their values. */
export function SecretTable() {
  const [secrets, setSecrets] = useState<SecretStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api.secrets().then((r) => setSecrets(r.secrets), () => setFailed(true)); }, []);
  const missing = secrets?.some((x) => !x.set && !x.optional);
  return (
    <>
      <div className="gh">
        Deployment secrets
        {secrets && <span className={`status ${missing ? 'bad' : 'ok'}`} data-testid="secret-count"><Icon n={missing ? 'xmark' : 'checkmark_alt'} />{secretsSummary(secrets)}</span>}
      </div>
      {failed && <div className="form-error" role="alert">Could not load the deployment secrets.</div>}
      {secrets && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Purpose</th><th className="hide-phone">Secret</th><th className="hide-phone">Used by</th><th className="num">Status</th></tr></thead>
            <tbody>
              {secrets.map((x) => (
                <tr key={x.name} data-testid="secret-row">
                  <td>{x.purpose}<div className="show-phone mono">{x.name}</div></td>
                  <td className="mono hide-phone">{x.name}</td>
                  <td className="hide-phone">{x.component}</td>
                  <td className="num"><Pill s={x} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Set per deployment (<span className="mono">deploy/settings</span> and the secret store). The app shows whether each one is set, never its value.</p>
        </div>
      )}
    </>
  );
}
