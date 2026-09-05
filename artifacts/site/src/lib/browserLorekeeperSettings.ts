export type BrowserLorekeeperPreference = "enabled" | "disabled" | "unset";

export const BROWSER_LOREKEEPER_PREFERENCE_KEY =
  "storyhold.browser-lorekeeper.preference.v1";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): PreferenceStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function getBrowserLorekeeperPreference(
  storage: PreferenceStorage | undefined = defaultStorage(),
): BrowserLorekeeperPreference {
  try {
    const value = storage?.getItem(BROWSER_LOREKEEPER_PREFERENCE_KEY);
    if (value === "enabled" || value === "disabled") return value;
  } catch {
    // A private/incognito browser may deny local storage. Treat that as no
    // consent rather than unexpectedly downloading a model.
  }
  return "unset";
}

export function setBrowserLorekeeperPreference(
  preference: Exclude<BrowserLorekeeperPreference, "unset">,
  storage: PreferenceStorage | undefined = defaultStorage(),
) {
  try {
    storage?.setItem(BROWSER_LOREKEEPER_PREFERENCE_KEY, preference);
  } catch {
    // The caller still uses the in-memory choice for the current action. A
    // future visit will ask again if this browser cannot retain preferences.
  }
}

export function clearBrowserLorekeeperPreference(
  storage: PreferenceStorage | undefined = defaultStorage(),
) {
  try {
    storage?.removeItem(BROWSER_LOREKEEPER_PREFERENCE_KEY);
  } catch {
    // Nothing else to clear when browser storage is unavailable.
  }
}

export function browserLorekeeperIsEnabled(storage?: PreferenceStorage) {
  return getBrowserLorekeeperPreference(storage) === "enabled";
}
