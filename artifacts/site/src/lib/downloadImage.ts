/**
 * Cross-device image download.
 *
 * Desktop: classic blob-URL + <a download> click.
 * Mobile (iOS Safari especially): the download-attribute trick silently
 * fails or navigates away, so we hand the file to the native share sheet
 * (which includes "Save Image") via the Web Share API. If that's not
 * available either, we open the image in a new tab so the user can
 * long-press → Save Image.
 */

function isTouchDevice(): boolean {
  return typeof navigator !== "undefined" && (navigator.maxTouchPoints > 0 || "ontouchstart" in window);
}

export async function downloadImage(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const blob = await res.blob();
  const type = blob.type || "image/png";
  const file = new File([blob], filename, { type });
  const mobile = isTouchDevice();

  // Mobile-first path: native share sheet with the actual file (iOS shows
  // "Save Image" in the sheet — the only reliable save path on iOS Safari).
  if (mobile && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      // AbortError = user dismissed the sheet — that's a completed interaction.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Anything else: fall through to the fallback below.
    }
  }

  // Mobile without a working file-share path: the blob + download-attribute
  // trick is exactly what fails on iOS Safari variants, so open the image
  // in a new tab instead — the user can long-press → Save Image.
  if (mobile) {
    window.open(url, "_blank", "noopener");
    return;
  }

  // Desktop path: blob URL + download attribute.
  const blobUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Delay revocation — revoking synchronously can cancel the download
    // on Safari/WebKit before it starts.
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  }
}
