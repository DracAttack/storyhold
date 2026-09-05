/** Unchanged editors must not reinterpret embedded delimiters in saved canon. */
export function dossierListFromEditor(
  original: readonly string[],
  draft: string,
  joinWith = "\n",
  splitOn: string | RegExp = "\n",
): string[] {
  if (draft === original.join(joinWith)) return [...original];
  return draft.split(splitOn).map((value) => value.trim()).filter(Boolean);
}
