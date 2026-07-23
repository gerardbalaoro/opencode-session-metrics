export function formatTokens(n: number) {
  return Math.round(n).toLocaleString("en-US");
}

export function formatCost(n: number) {
  return `$${n.toFixed(2)}`;
}
