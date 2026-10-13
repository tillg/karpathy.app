import type { ContextUsage } from '@karpathy/shared';

/**
 * How full a chat's context is (#140): `bar` is the thin track in the chat list, `full` adds the numbers
 * (composer). Unknown window: `full` shows the tokens only, `bar` nothing. Numbers short (`29K / 1M`), in the
 * browser's locale.
 */
export function ContextMeter({ usage, variant, model, locale }: { usage: ContextUsage; variant: 'bar' | 'full'; model?: string; locale?: string }) {
  const { used, limit } = usage;
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const num = (x: number) => x < 1000 ? fmt.format(x) : Math.round(x / 1000) < 1000 ? `${Math.round(x / 1000)}K` : `${fmt.format(x / 1e6)}M`;
  if (!limit) return variant === 'full' ? <div className="ctx-meter" data-testid="context-meter">{num(used)} tokens</div> : null;
  const share = used / limit;
  const level = share >= 0.9 ? 'crit' : share >= 0.7 ? 'warn' : 'ok';
  const bar = (
    <span className={`ctx-bar ${level}`} role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
      <span style={{ width: `${Math.min(100, share * 100)}%` }} />
    </span>
  );
  if (variant === 'bar') return bar;
  const name = model ? model.slice(model.indexOf('/') + 1) : 'the model';
  return (
    <div className="ctx-meter" data-testid="context-meter" title={`${new Intl.NumberFormat(locale, { style: 'percent' }).format(Math.round(share * 100) / 100)} of ${name}'s context · drops when the chat is compacted`}>
      {bar}<span className="ctx-num">{num(used)} / {num(limit)}</span>
    </div>
  );
}
