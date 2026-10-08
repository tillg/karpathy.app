import type { TokenTest } from '@karpathy/shared';
import type { ConfigStore } from './config-store.js';

/**
 * The one server-wide GitHub token: the one set in the app (config store) wins over the
 * deployment's `github_token` secret (settings `git.github_token`), which stays the fallback.
 */
export class GitHubToken {
  /** Every value used since startup, so errors never leak an old token either. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly store: ConfigStore,
    private readonly secret: string | undefined,
    private readonly apiBase = 'https://api.github.com',
  ) {
    for (const t of [secret, store.get().githubToken]) if (t) this.seen.add(t);
  }

  current(): string | undefined {
    return this.store.get().githubToken ?? this.secret;
  }

  source(): 'settings' | 'secret' | 'none' {
    return this.store.get().githubToken ? 'settings' : this.secret ? 'secret' : 'none';
  }

  /** Masks `token` from now on, also when it is only tested, never saved. */
  remember(token: string) {
    this.seen.add(token);
  }

  async set(token: string) {
    this.remember(token);
    await this.store.update((c) => { c.githubToken = token; });
  }

  async clear() {
    await this.store.update((c) => { delete c.githubToken; });
  }

  /** Who GitHub says `token` belongs to (`GET /user`), with its scopes and expiry. */
  async identity(token: string | undefined): Promise<Omit<TokenTest, 'vaults'>> {
    if (!token) return { ok: false, error: 'No GitHub token set.' };
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/user`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'karpathy.app' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { ok: false, error: 'GitHub is not reachable from the server right now.' };
    }
    if (!res.ok) return { ok: false, error: `GitHub rejected the token (${res.status}).` };
    const user = (await res.json()) as { login?: string };
    const scopes = res.headers.get('x-oauth-scopes');
    const expiry = res.headers.get('github-authentication-token-expiration');
    return {
      ok: true,
      login: user.login,
      ...(scopes !== null ? { scopes: scopes.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
      ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
    };
  }

  redact(msg: string): string {
    for (const t of this.seen) msg = msg.replaceAll(t, '***');
    return msg;
  }
}
