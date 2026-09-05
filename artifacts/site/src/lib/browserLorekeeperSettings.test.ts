import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_LOREKEEPER_PREFERENCE_KEY,
  browserLorekeeperIsEnabled,
  clearBrowserLorekeeperPreference,
  getBrowserLorekeeperPreference,
  setBrowserLorekeeperPreference,
} from "./browserLorekeeperSettings";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    values,
  };
}

test("browser intelligence is opt-in and retained per device", () => {
  const storage = memoryStorage();
  assert.equal(getBrowserLorekeeperPreference(storage), "unset");
  assert.equal(browserLorekeeperIsEnabled(storage), false);

  setBrowserLorekeeperPreference("enabled", storage);
  assert.equal(
    storage.values.get(BROWSER_LOREKEEPER_PREFERENCE_KEY),
    "enabled",
  );
  assert.equal(browserLorekeeperIsEnabled(storage), true);

  setBrowserLorekeeperPreference("disabled", storage);
  assert.equal(getBrowserLorekeeperPreference(storage), "disabled");
  assert.equal(browserLorekeeperIsEnabled(storage), false);

  clearBrowserLorekeeperPreference(storage);
  assert.equal(getBrowserLorekeeperPreference(storage), "unset");
});

test("unrecognized or unavailable storage never grants consent", () => {
  const storage = memoryStorage();
  storage.values.set(BROWSER_LOREKEEPER_PREFERENCE_KEY, "yes-please");
  assert.equal(getBrowserLorekeeperPreference(storage), "unset");
  assert.equal(getBrowserLorekeeperPreference(undefined), "unset");
});
