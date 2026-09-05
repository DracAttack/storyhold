import { useEffect, useRef, useState } from "react";
import { FaFacebookF, FaXTwitter, FaLinkedinIn, FaPinterestP, FaRedditAlien, FaInstagram, FaSnapchat } from "react-icons/fa6";
import { Link2, Check } from "lucide-react";
import type { IconType } from "react-icons";
import { useRecordShareEvent, type SocialPack } from "@workspace/api-client-react";
import { trackShare } from "@/lib/analytics";

interface ShareButtonsProps {
  /** Path (e.g. "/article/foo") or absolute URL to share. */
  url: string;
  /** Title/description used for the share text. */
  title: string;
  /** Article slug — used for share tracking. Derived from `url` when omitted. */
  slug?: string;
  /** Absolute image URL — used by Pinterest as the pinned media. */
  image?: string;
  /**
   * Optional ready-to-post per-platform copy. When present, each platform's
   * share intent uses its matching caption (X post, Reddit title, Pinterest
   * description, Instagram native-share text) instead of the headline.
   * UTM tagging and links are unchanged.
   */
  socialPack?: SocialPack | null;
  /** Optional leading label. Defaults to "Share". */
  label?: string;
  className?: string;
}

function toAbsolute(u: string): string {
  if (!u) return u;
  if (u.startsWith("http")) return u;
  if (typeof window !== "undefined") {
    try {
      return new URL(u, window.location.origin).href;
    } catch {
      return u;
    }
  }
  return u;
}

type Platform = "facebook" | "x" | "linkedin" | "pinterest" | "reddit" | "copy" | "instagram" | "native" | "snapchat";

interface ShareTarget {
  platform: Platform;
  name: string;
  Icon: IconType;
  href: string;
  brand: string;
  /** Optional icon/foreground color. Defaults to white; set for light brand fills. */
  fg?: string;
}

/** Copy text to the clipboard, with a fallback for browsers without the async API. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch an image URL as a File so it can be handed to the Web Share API. Used to
 * share the article's 9:16 snap card as an actual image (so Snapchat opens it as
 * a postable snap) instead of a bare text+link. Same-origin (served via /api on
 * the same host), so no CORS dance. Returns null on any failure so callers can
 * fall back to a link share.
 */
async function fetchShareFile(imageUrl: string): Promise<File | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    return new File([blob], "brainhook-snap.jpg", { type: blob.type });
  } catch {
    return null;
  }
}

export default function ShareButtons({ url, title, slug, image, socialPack, label = "Share", className = "" }: ShareButtonsProps) {
  const shareUrl = toAbsolute(url);
  // Per-platform caption resolution: use the social-pack copy when non-blank,
  // else the headline. Keeps share intents working when no pack exists.
  const caption = (text: string | null | undefined): string => {
    const t = (text ?? "").trim();
    return t || title;
  };
  const xText = caption(socialPack?.twitter);
  const redditText = caption(socialPack?.reddit);
  const pinterestText = caption(socialPack?.pinterestDescription);
  const instagramText = caption(socialPack?.altCaptions?.[0]);
  const shareImage = image ? toAbsolute(image) : undefined;
  // Stable identifier for this content (article slug, or an explicit page key
  // like "home"), used both for share tracking and as the distinct utm_content
  // tag below so every article/page shares its OWN attributable link.
  const trackedSlug = slug ?? (shareUrl.replace(/^.*\/article\//, "").replace(/[/?#].*$/, "") || shareUrl);

  // Tag reader shares with UTM params so returning traffic is attributable in
  // Google Analytics and the admin Shares report. utm_source is the destination
  // (platform / "copy" / device "share"); medium + campaign are fixed; and
  // utm_content carries the per-article/page identifier so each piece of content
  // shares a DISTINCT UTM. buildTagged returns the raw URL; taggedUrl returns it
  // encoded for embedding in a platform share-intent query string.
  const buildTagged = (source: string): string => {
    try {
      const tagged = new URL(shareUrl);
      tagged.searchParams.set("utm_source", source);
      tagged.searchParams.set("utm_medium", "social");
      tagged.searchParams.set("utm_campaign", "social_share");
      tagged.searchParams.set("utm_content", trackedSlug);
      return tagged.toString();
    } catch {
      return shareUrl;
    }
  };
  const taggedUrl = (source: string): string => encodeURIComponent(buildTagged(source));
  const [copied, setCopied] = useState(false);
  const [igCopied, setIgCopied] = useState(false);
  // Whether to route the unreliable-on-mobile networks through the OS share
  // sheet. Resolved post-mount (so SSR markup matches the client and there's no
  // hydration mismatch) = phone-width AND `navigator.share` available. Governs
  // Facebook, Instagram, and Snapchat; the other networks' web intents work on mobile.
  const [nativeShare, setNativeShare] = useState(false);
  const record = useRecordShareEvent();

  // The 9:16 vertical "snap card" for this share: the article's share image
  // letterboxed to 9:16 by the API (`?snap=1`), or the static branded vertical
  // card on imageless routes (homepage). This is what gets handed to Snapchat as
  // an actual image so it opens as a postable snap (Story/Spotlight).
  const snapImageUrl = shareImage
    ? `${shareImage}${shareImage.includes("?") ? "&" : "?"}snap=1`
    : toAbsolute("/opengraph-snap.jpg");
  // Cache the fetched snap File + its in-flight fetch so the share happens within
  // the click's user-activation window (priming on pointerdown gives the fetch a
  // head start; iOS drops the activation if we first await a slow network call).
  const snapFileRef = useRef<File | null>(null);
  const snapFetchRef = useRef<Promise<File | null> | null>(null);
  const primeSnapFile = (): Promise<File | null> => {
    if (snapFetchRef.current) return snapFetchRef.current;
    const p = fetchShareFile(snapImageUrl).then((f) => {
      snapFileRef.current = f;
      return f;
    });
    snapFetchRef.current = p;
    return p;
  };
  // Share the snap card image to Snapchat (and any other image-capable target the
  // user picks from the sheet). Falls back to a link share only when no image can
  // be fetched — never re-prompts after the user dismisses the file sheet.
  const shareSnap = async () => {
    const file = snapFileRef.current ?? (await primeSnapFile());
    const taggedShareUrl = buildTagged("share");
    if (file && typeof navigator.canShare === "function") {
      // Prefer sharing the image AND the link/caption together so the snap card
      // carries the URL (the user wants the link auto-populated alongside the
      // card). Some targets reject files + url in one payload — fall back to the
      // image alone before giving up on the file entirely.
      const withLink = { files: [file], title, text: title, url: taggedShareUrl };
      const fileOnly = { files: [file] };
      const payload = navigator.canShare(withLink) ? withLink : navigator.canShare(fileOnly) ? fileOnly : null;
      if (payload) {
        try {
          await navigator.share(payload);
        } catch {
          // User dismissed the sheet (AbortError) or the share failed.
        }
        return;
      }
    }
    try {
      await navigator.share?.({ title, text: title, url: taggedShareUrl });
    } catch {
      // User dismissed the sheet (AbortError) or it failed — nothing to do.
    }
  };

  useEffect(() => {
    const isMobile = window.matchMedia?.("(max-width: 767px)")?.matches ?? false;
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    setNativeShare(isMobile && canShare);
  }, []);

  // Drop the cached snap File when the target image changes (this component
  // instance is reused across article-route transitions), so we never share a
  // previous article's snap. Also lets a transient fetch failure retry.
  useEffect(() => {
    snapFileRef.current = null;
    snapFetchRef.current = null;
  }, [snapImageUrl]);

  // Fire both trackers on a share. Best-effort: GA + a backend POST, neither of
  // which may block or break the actual share navigation/popup.
  const track = (platform: Platform) => {
    trackShare(platform, trackedSlug, title);
    record.mutate({ data: { slug: trackedSlug, title, platform } });
  };

  const targets: ShareTarget[] = [
    {
      platform: "facebook",
      name: "Share on Facebook",
      Icon: FaFacebookF,
      href: `https://www.facebook.com/sharer/sharer.php?u=${taggedUrl("facebook")}`,
      brand: "#1877F2",
    },
    {
      platform: "x",
      name: "Share on X",
      Icon: FaXTwitter,
      href: `https://twitter.com/intent/tweet?url=${taggedUrl("x")}&text=${encodeURIComponent(xText)}`,
      brand: "#000000",
    },
    {
      platform: "linkedin",
      name: "Share on LinkedIn",
      Icon: FaLinkedinIn,
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${taggedUrl("linkedin")}`,
      brand: "#0A66C2",
    },
    {
      platform: "reddit",
      name: "Share on Reddit",
      Icon: FaRedditAlien,
      href: `https://www.reddit.com/submit?url=${taggedUrl("reddit")}&title=${encodeURIComponent(redditText)}`,
      brand: "#FF4500",
    },
    {
      platform: "pinterest",
      name: "Pin on Pinterest",
      Icon: FaPinterestP,
      href: `https://pinterest.com/pin/create/button/?url=${taggedUrl("pinterest")}&description=${encodeURIComponent(pinterestText)}${
        shareImage ? `&media=${encodeURIComponent(shareImage)}` : ""
      }`,
      brand: "#E60023",
    },
    {
      platform: "snapchat",
      name: "Share on Snapchat",
      Icon: FaSnapchat,
      // DESKTOP path only: Snapchat's web "share link" opens the share view in a
      // browser. On mobile this URL just deep-links into the app and attaches
      // nothing, so phones route Snapchat through the OS share sheet instead (see
      // openShare) — exactly like Facebook/Instagram.
      href: `https://www.snapchat.com/share?link=${taggedUrl("snapchat")}`,
      // Snapchat yellow needs a dark ghost — white-on-yellow is unreadable.
      brand: "#FFFC00",
      fg: "#000000",
    },
  ];

  const openShare = async (e: React.MouseEvent<HTMLAnchorElement>, target: ShareTarget) => {
    track(target.platform);
    if (typeof window === "undefined") return;
    // Some networks dead-end when their web link is handed to the installed app
    // on a phone: Facebook opens the app but not a compose screen (or shows a
    // Safari login wall), and Snapchat's web share link just opens the app and
    // attaches nothing. On phones with the Web Share API, route these through the
    // OS share sheet — where the apps actually accept the link — instead.
    if (nativeShare && target.platform === "snapchat") {
      e.preventDefault();
      // Snapchat via the share sheet ignores a bare URL (it just sends a text
      // message with a link). Hand it the 9:16 snap card as an IMAGE FILE so it
      // opens as an actual snap the user can post to their Story or Spotlight.
      track("native");
      await shareSnap();
      return;
    }
    if (nativeShare && target.platform === "facebook") {
      e.preventDefault();
      // Also log the generic device-share event so native-sheet shares are
      // measurable on their own, distinct from the originating button.
      track("native");
      try {
        await navigator.share?.({ title, text: title, url: buildTagged("share") });
      } catch {
        // User dismissed the sheet (AbortError) or it failed — nothing to do.
      }
      return;
    }
    // On small/touch screens, let the anchor's native target="_blank" navigation
    // happen. A sized window.open() is treated as a popup and blocked by mobile
    // browsers; a plain user-initiated new tab is not.
    if (window.matchMedia?.("(max-width: 767px)").matches) return;
    e.preventDefault();
    const width = 600;
    const height = 620;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      target.href,
      "share-dialog",
      `noopener,noreferrer,width=${width},height=${height},left=${left},top=${top}`,
    );
    // If a popup blocker prevented the window, fall back to a normal new tab so
    // the share never fails silently.
    if (!popup) window.open(target.href, "_blank", "noopener,noreferrer");
  };

  const handleCopy = async () => {
    track("copy");
    if (await writeClipboard(buildTagged("copy"))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  // Instagram has no web link-share URL. On a phone, open the native sheet (where
  // Instagram is a target); on desktop, copy the link with a hint to paste it
  // into a story/bio, since there's no way to hand a URL to Instagram on the web.
  const handleInstagram = async () => {
    track("instagram");
    if (nativeShare) {
      // Instagram is reached via the device share sheet; record the generic
      // native-share event alongside the distinct "instagram" event above.
      track("native");
      try {
        await navigator.share?.({ title, text: instagramText, url: buildTagged("share") });
      } catch {
        // User dismissed the sheet (AbortError) or it failed — nothing to do.
      }
      return;
    }
    if (await writeClipboard(buildTagged("instagram"))) {
      setIgCopied(true);
      window.setTimeout(() => setIgCopied(false), 3500);
    }
  };

  const iconBtn =
    "flex h-9 w-9 items-center justify-center rounded-full text-white transition-transform duration-200 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary";

  return (
    <div className={`flex items-center gap-3 flex-wrap ${className}`}>
      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 flex-wrap">
        {targets.map((target) => {
          const { name, Icon, href, brand, fg } = target;
          return (
            <a
              key={name}
              href={href}
              onClick={(e) => openShare(e, target)}
              onPointerDown={
                nativeShare && target.platform === "snapchat"
                  ? () => {
                      // Start fetching the snap image on press so it's ready
                      // inside the click's user-activation window.
                      void primeSnapFile();
                    }
                  : undefined
              }
              target="_blank"
              rel="noopener noreferrer"
              aria-label={name}
              title={name}
              className={iconBtn}
              style={{ backgroundColor: brand, color: fg }}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </a>
          );
        })}

        <button
          type="button"
          onClick={handleInstagram}
          aria-label="Share on Instagram"
          title={igCopied ? "Link copied — paste into your Instagram story or bio" : "Share on Instagram"}
          className={iconBtn}
          style={{ background: "linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)" }}
        >
          {igCopied ? <Check className="h-4 w-4" aria-hidden="true" /> : <FaInstagram className="h-4 w-4" aria-hidden="true" />}
        </button>

        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Link copied" : "Copy link"}
          title={copied ? "Copied!" : "Copy link"}
          className={`flex h-9 items-center justify-center gap-1.5 rounded-full text-white transition-all duration-200 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary ${
            copied ? "px-3" : "w-9"
          }`}
          style={{ backgroundColor: copied ? "#16a34a" : "#4b5563" }}
        >
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
          {copied && <span className="text-xs font-semibold">Copied!</span>}
        </button>
      </div>

      {igCopied && (
        <span className="w-full text-xs font-medium text-muted-foreground">
          Link copied — paste it into your Instagram story or bio.
        </span>
      )}
    </div>
  );
}
