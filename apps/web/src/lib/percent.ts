/** Whole percent of `total` (0 when there is no total). */
export const percent = (x: number, total: number) => (total ? Math.round((x / total) * 100) : 0);
export const pct = (x: number, total: number) => `${percent(x, total)} %`;
