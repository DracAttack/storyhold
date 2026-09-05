export const DOSSIER_PREVIEW_ITEMS = 8;

/** A presentation window only. The caller retains the full original list for
 * editing, saving, and subsequent expansion; no item text is shortened. */
export function dossierListWindow<T>(values: readonly T[], requestedCount = DOSSIER_PREVIEW_ITEMS) {
  const requested = Number.isFinite(requestedCount) ? Math.max(DOSSIER_PREVIEW_ITEMS, Math.floor(requestedCount)) : DOSSIER_PREVIEW_ITEMS;
  const shownCount = Math.min(values.length, requested);
  return { visibleValues: values.slice(0, shownCount), shownCount, total: values.length,
    hasMore: shownCount < values.length, nextCount: Math.min(values.length, shownCount + DOSSIER_PREVIEW_ITEMS) };
}
