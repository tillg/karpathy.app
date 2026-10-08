/** The header brand: `karpathy #N` on dev stack N (VITE_STACK, set by compose.dev.yml), else `karpathy.app`. */
export const brandName = (stack?: string) => (stack && /^[1-9]$/.test(stack) ? `karpathy #${stack}` : 'karpathy.app');
