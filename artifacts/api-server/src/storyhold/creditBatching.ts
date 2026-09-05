export function largestAffordablePrefix(
  itemCount: number,
  availableCredits: number,
  creditsForPrefix: (count: number) => number,
): number {
  const normalizedCount = Math.max(0, Math.floor(itemCount));
  const normalizedCredits = Math.max(0, Math.floor(availableCredits));
  let affordableCount = 0;
  let low = 1;
  let high = normalizedCount;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (creditsForPrefix(middle) <= normalizedCredits) {
      affordableCount = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return affordableCount;
}
