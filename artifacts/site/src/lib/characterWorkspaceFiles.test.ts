import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CharacterWorkspace, WorkspacePrivateImage, type CharacterWorkspaceProps } from "../components/customer/character-workspace";
import { getCharacterWorkspacePreviewUrl, mergeWorkspaceScanUpdates, workspaceFileAccess } from "./characterWorkspaceFiles";
import type { CharacterWorkspaceItem } from "./storyholdApi";

const image: CharacterWorkspaceItem = {
  id: "item-1", kind: "file", title: "Costume Reference", provenance: "manual", sortOrder: 0,
  createdAt: "2026-09-09T12:00:00Z", updatedAt: "2026-09-09T12:00:00Z",
  file: { name: "portrait.png", size: 100, type: "image/png", scan: { state: "clean", checkedAt: "2026-09-09T12:00:00Z" } },
};
const noop = async () => {};
function renderItems(items: CharacterWorkspaceItem[], extra: Partial<CharacterWorkspaceProps> = {}) {
  return renderToStaticMarkup(createElement(CharacterWorkspace, {
    worldId: "world-1", characterId: "character-1", items, references: [],
    onAddNote: noop, onAddFile: noop, onLinkReference: noop, onUpdateItem: noop,
    onRemoveItem: noop, onReorderItems: noop, onOpenFile: noop, ...extra,
  }));
}

test("only an explicitly clean file unlocks previews or downloads", () => {
  assert.equal(workspaceFileAccess(image).available, true);
  for (const scan of [undefined, { state: "pending" as const }, { state: "quarantined" as const, reason: "suspicious" as const }, { state: "quarantined" as const, reason: "scan_failed" as const }]) {
    const item = { ...image, file: { ...image.file!, scan } };
    assert.equal(workspaceFileAccess(item).available, false);
    assert.equal(workspaceFileAccess(item).previewable, false);
  }
  const unknown = { ...image, file: { ...image.file!, scan: { state: "not-a-real-state" } } } as unknown as CharacterWorkspaceItem;
  assert.equal(workspaceFileAccess(unknown).available, false);
  assert.equal(workspaceFileAccess(unknown).pending, true);
  assert.equal(workspaceFileAccess({ ...image, kind: "note" }).available, false);
  assert.equal(workspaceFileAccess({ ...image, file: undefined }).pending, false);
});

test("quarantined scan retries continue refreshing without unlocking the file", () => {
  const retrying: CharacterWorkspaceItem = { ...image, file: { ...image.file!, scan: { state: "quarantined", reason: "scan_failed", retryPending: true } } };
  const access = workspaceFileAccess(retrying);
  assert.equal(access.pending, true);
  assert.equal(access.available, false);
  assert.equal(access.previewable, false);
  const html = renderItems([retrying]);
  assert.match(html, /File Quarantined/u);
  assert.match(html, /retry automatically/u);
  assert.doesNotMatch(html, /<img|src=|Open Preview|>Download</u);
  const clean = mergeWorkspaceScanUpdates([retrying], [image])[0];
  assert.equal(workspaceFileAccess(clean).pending, false);
  assert.equal(workspaceFileAccess(clean).previewable, true);
  const exhausted = { ...retrying, file: { ...retrying.file!, scan: { ...retrying.file!.scan!, retryPending: false } } };
  assert.equal(workspaceFileAccess(exhausted).pending, false);
  assert.equal(workspaceFileAccess(exhausted).available, false);
  const suspicious = { ...retrying, file: { ...retrying.file!, scan: { state: "quarantined" as const, reason: "suspicious" as const, retryPending: true } } };
  assert.equal(workspaceFileAccess(suspicious).pending, false);
});

test("only supported raster image types receive private previews", () => {
  for (const type of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
    assert.equal(workspaceFileAccess({ ...image, file: { ...image.file!, type } }).previewable, true);
  }
  for (const type of ["application/pdf", "text/plain", "image/svg+xml", "text/html", "image/avif"]) {
    assert.equal(workspaceFileAccess({ ...image, file: { ...image.file!, type } }).previewable, false);
  }
});

test("preview addresses are same-origin private routes with every identifier encoded", () => {
  const url = getCharacterWorkspacePreviewUrl({ worldId: "world/other", characterId: "person?secret", itemId: "file#../private" });
  assert.equal(url, "/api/storyhold/worlds/world%2Fother/characters/person%3Fsecret/workspace/file%23..%2Fprivate/preview");
  assert.doesNotMatch(url, /^https?:|blob:|objectKey|filename/u);
});

test("clean images show compact lazy previews and accessible actions", () => {
  const html = renderItems([image]);
  assert.match(html, /<img[^>]+src="\/api\/storyhold\/worlds\/world-1\/characters\/character-1\/workspace\/item-1\/preview"/u);
  assert.match(html, /loading="lazy"/u);
  assert.match(html, /referrerPolicy="no-referrer"/iu);
  assert.match(html, /Preview Costume Reference/u);
  assert.match(html, /Actions for Costume Reference/u);
  assert.match(html, /Loading Image/u);
  assert.match(html, /h-24 w-36 max-w-full/u);
  assert.match(html, /Safety Check Complete/u);
});

test("pending and quarantined files never render a media request or download button", () => {
  for (const scan of [undefined, { state: "pending" as const }, { state: "quarantined" as const, reason: "suspicious" as const }, { state: "quarantined" as const, reason: "scan_failed" as const }]) {
    const html = renderItems([{ ...image, file: { ...image.file!, scan } }]);
    assert.doesNotMatch(html, /<img|src=|Open Preview|>Download</u);
    assert.match(html, /role="status"/u);
    assert.match(html, scan?.state === "quarantined" ? /File Quarantined/u : /Safety Check Pending/u);
    if (scan?.reason === "suspicious") assert.match(html, /flagged this file/u);
    if (scan?.reason === "scan_failed") assert.match(html, /could not finish/u);
  }
});

test("documents retain downloads without image rendering and empty workspaces remain clear", () => {
  const document = { ...image, file: { ...image.file!, type: "application/pdf", name: "notes.pdf" } };
  const html = renderItems([document]);
  assert.match(html, />Download</u);
  assert.doesNotMatch(html, /<img|Open Preview/u);
  assert.match(renderItems([]), /folio is empty/iu);
  assert.match(renderItems([]), /attach reference images/u);
});

test("expanded image requests retain private endpoint and accessible loading presentation", () => {
  const url = getCharacterWorkspacePreviewUrl({ worldId: "world-1", characterId: "character-1", itemId: image.id });
  const html = renderToStaticMarkup(createElement(WorkspacePrivateImage, { url, title: image.title, expanded: true }));
  assert.match(html, /loading="eager"/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /max-h-\[65vh\]/u);
  assert.ok(html.includes(url));
  const source = readFileSync(new URL("../components/customer/character-workspace.tsx", import.meta.url), "utf8");
  assert.match(source, /onError=\{\(\) => setStatus\("error"\)\}/u);
  assert.match(source, /Preview Unavailable/u);
  assert.match(source, /Try Again/u);
  assert.match(source, /max-h-\[90dvh\] overflow-y-auto/u);
  assert.doesNotMatch(source, /item\.objectPath|file\.objectKey|createObjectURL/u);
});

test("scan polling cannot resurrect deleted items or overwrite edits and ordering", () => {
  const pending = { ...image, title: "Owner Renamed This", sortOrder: 4, file: { ...image.file!, scan: { state: "pending" as const } } };
  const deleted = { ...image, id: "deleted-item" };
  const added = { ...pending, id: "new-item" };
  const current = [added, pending];
  const result = mergeWorkspaceScanUpdates(current, [image, deleted]);
  assert.deepEqual(result.map((item) => item.id), ["new-item", image.id]);
  assert.equal(result[1].title, pending.title);
  assert.equal(result[1].sortOrder, 4);
  assert.equal(result[1].file?.scan?.state, "clean");
  assert.equal(result[0].file?.scan?.state, "pending");
  assert.equal(current[1].file?.scan?.state, "pending");
});

test("scan refresh failures stay visible only while files are pending", () => {
  assert.doesNotMatch(renderItems([image], { scanRefreshFailed: true }), /updates are temporarily unavailable/u);
  const pending = { ...image, file: { ...image.file!, scan: { state: "pending" as const } } };
  assert.match(renderItems([pending], { scanRefreshFailed: true }), /updates are temporarily unavailable/u);
  const page = readFileSync(new URL("../pages/profile-character.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(!active \|\| running \|\| !isVisible\(\)\) return/u);
  assert.match(page, /setTimeout\(\(\) => void poll\(\), 5_000\)/u);
  assert.match(page, /listCharacterWorkspace\(worldId, characterId, controller.signal\)/u);
  assert.match(page, /document.removeEventListener\("visibilitychange", onVisibility\)/u);
  assert.match(page, /request\?\.abort\(\)/u);
});
