import { Link, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Link2, Check } from "lucide-react";
import { FaFacebookF, FaXTwitter, FaLinkedinIn, FaRedditAlien, FaPinterestP } from "react-icons/fa6";
import { useBeats } from "@/lib/useBeats";
import { useRecordShareEvent } from "@workspace/api-client-react";
import { trackShare } from "@/lib/analytics";
import brainMark from "@/assets/brainhook-mark.png";

const SIDENAV_SEEN_KEY = "bh_sidenav_seen";

// Pill width is px-1.5 (6px each side) + 20px icon = 32px. Social dock matches.
const PILL_W = 34; // px — matches collapsed chevron pill width

// Share the current page URL to a platform.
function buildTagged(source: string): string {
  if (typeof window === "undefined") return "";
  try {
    const tagged = new URL(window.location.href);
    tagged.searchParams.set("utm_source", source);
    tagged.searchParams.set("utm_medium", "social");
    tagged.searchParams.set("utm_campaign", "social_share");
    tagged.searchParams.set("utm_content", "sidebar");
    return tagged.toString();
  } catch {
    return window.location.href;
  }
}

function openPopup(url: string) {
  const w = 600, h = 620;
  const l = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const t = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const popup = window.open(url, "share-dialog", `noopener,noreferrer,width=${w},height=${h},left=${l},top=${t}`);
  if (!popup) window.open(url, "_blank", "noopener,noreferrer");
}

interface SocialDockProps {
  record: ReturnType<typeof useRecordShareEvent>;
}

function SocialDock({ record }: SocialDockProps) {
  const [copied, setCopied] = useState(false);

  const track = (platform: string) => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    const slug = url.replace(/^.*\/article\//, "").replace(/[/?#].*$/, "") || "page";
    const title = typeof document !== "undefined" ? document.title : "BrainHook";
    trackShare(platform as Parameters<typeof trackShare>[0], slug, title);
    record.mutate({ data: { slug, title, platform: platform as "facebook" | "x" | "linkedin" | "pinterest" | "reddit" | "copy" | "instagram" | "native" | "snapchat" } });
  };

  const share = (e: React.MouseEvent, platform: string, href: string) => {
    e.preventDefault();
    track(platform);
    openPopup(href);
  };

  const handleCopy = async () => {
    track("copy");
    const url = buildTagged("copy");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const btnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: "50%",
    border: "none",
    cursor: "pointer",
    transition: "opacity 0.15s",
    color: "#fff",
  };

  const platforms = [
    {
      id: "facebook", label: "Share on Facebook", color: "#1877F2",
      href: () => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(buildTagged("facebook"))}`,
      Icon: FaFacebookF,
    },
    {
      id: "x", label: "Share on X", color: "#000",
      href: () => `https://twitter.com/intent/tweet?url=${encodeURIComponent(buildTagged("x"))}&text=${encodeURIComponent(typeof document !== "undefined" ? document.title : "BrainHook")}`,
      Icon: FaXTwitter,
    },
    {
      id: "linkedin", label: "Share on LinkedIn", color: "#0A66C2",
      href: () => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(buildTagged("linkedin"))}`,
      Icon: FaLinkedinIn,
    },
    {
      id: "reddit", label: "Share on Reddit", color: "#FF4500",
      href: () => `https://www.reddit.com/submit?url=${encodeURIComponent(buildTagged("reddit"))}&title=${encodeURIComponent(typeof document !== "undefined" ? document.title : "BrainHook")}`,
      Icon: FaRedditAlien,
    },
    {
      id: "pinterest", label: "Pin on Pinterest", color: "#E60023",
      href: () => `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(buildTagged("pinterest"))}`,
      Icon: FaPinterestP,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 0 4px 4px" }}>
      {platforms.map(({ id, label, color, href, Icon }) => (
        <a
          key={id}
          href={href()}
          onClick={(e) => share(e, id, href())}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          title={label}
          style={{ ...btnStyle, backgroundColor: color }}
        >
          <Icon style={{ width: 12, height: 12 }} aria-hidden />
        </a>
      ))}
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied!" : "Copy link"}
        title={copied ? "Copied!" : "Copy link"}
        style={{ ...btnStyle, backgroundColor: copied ? "#16a34a" : "#374151" }}
      >
        {copied
          ? <Check style={{ width: 12, height: 12 }} aria-hidden />
          : <Link2 style={{ width: 12, height: 12 }} aria-hidden />
        }
      </button>
    </div>
  );
}

export default function BeatSideNav() {
  const [location] = useLocation();
  const { beats, isLoading } = useBeats();
  const record = useRecordShareEvent();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      // Default CLOSED. "0" = user explicitly opened it in this session.
      return window.sessionStorage.getItem(SIDENAV_SEEN_KEY) !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(SIDENAV_SEEN_KEY, collapsed ? "1" : "0");
    } catch { /* ignore */ }
  }, [collapsed]);

  const asideRef = useRef<HTMLElement | null>(null);
  const lastCloseTimeRef = useRef(0);

  // ALWAYS-ON capture-phase click blocker. When the panel is closed by an
  // outside touch/click, the gated effect below tears its listeners down on
  // re-render — so the synthetic click that follows a touchstart used to land
  // on whatever link was underneath and navigate. This listener never unmounts,
  // so it can swallow that follow-up click regardless of collapse state.
  useEffect(() => {
    const blockClickAfterClose = (e: MouseEvent) => {
      if (Date.now() - lastCloseTimeRef.current < 400) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("click", blockClickAfterClose, true);
    return () => window.removeEventListener("click", blockClickAfterClose, true);
  }, []);

  useEffect(() => {
    if (collapsed) return;

    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && asideRef.current && asideRef.current.contains(target)) return;
      // Outside click while open: quietly close, never follow the link.
      lastCloseTimeRef.current = Date.now();
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setCollapsed(true);
    };

    const onTouchStart = (e: TouchEvent) => {
      const target = e.target as Node | null;
      if (target && asideRef.current && asideRef.current.contains(target)) return;
      lastCloseTimeRef.current = Date.now();
      setCollapsed(true);
    };

    const onWheel = (e: WheelEvent) => {
      const target = e.target as Node | null;
      if (target && asideRef.current && asideRef.current.contains(target)) return;
      setCollapsed(true);
    };

    window.addEventListener("click", onClick, true);
    window.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    window.addEventListener("wheel", onWheel, { passive: true, capture: true });

    return () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [collapsed]);

  if (isLoading || beats.length === 0) return null;

  if (collapsed) {
    return (
      <>
        {/* Chevron pill — vertically centred */}
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="fixed left-0 top-[38%] -translate-y-1/2 z-40 flex flex-col items-center gap-1.5 rounded-r-lg bg-primary text-primary-foreground py-3 px-1.5 shadow-md hover:bg-primary/90 transition-colors"
          aria-label="Show categories"
          title="Show categories"
        >
          <img src={brainMark} alt="" aria-hidden="true" width={20} height={20} className="h-5 w-5 select-none" />
          <ChevronRight className="h-4 w-4" />
        </button>

        {/* Social dock — fixed just below the chevron's bottom edge.
            Chevron: centred at 38%, height ≈66px → bottom at calc(38% + 33px).
            Dock starts 6px below that. z-39 so the open panel (z-40) covers it. */}
        <div
          className="fixed left-0 z-[39]"
          style={{ top: "calc(38% + 39px)" }}
        >
          <SocialDock record={record} />
        </div>
      </>
    );
  }

  return (
    <aside
      ref={asideRef}
      aria-label="Categories"
      className="fixed left-3 top-1/2 -translate-y-1/2 z-40 w-80 max-h-[calc(100vh-1.5rem)] overflow-y-auto rounded-2xl border border-border/60 bg-background/90 shadow-2xl shadow-black/30 backdrop-blur-md supports-[backdrop-filter]:bg-background/75 ring-1 ring-white/5"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          <img src={brainMark} alt="" aria-hidden="true" width={18} height={18} className="h-[18px] w-[18px] select-none" />
          Categories
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Hide categories"
          title="Hide categories"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
      <nav className="flex flex-col py-1.5">
        <Link
          href="/"
          onClick={() => setCollapsed(true)}
          className={`px-4 py-2.5 text-[1.05rem] font-medium transition-colors hover:bg-muted ${
            location === "/" ? "text-primary" : "text-foreground"
          }`}
        >
          Home
        </Link>
        {beats.map((b) => {
          const active = location === `/category/${b.slug}`;
          return (
            <Link
              key={b.slug}
              href={`/category/${b.slug}`}
              onClick={() => setCollapsed(true)}
              className={`px-4 py-2.5 text-[1.05rem] leading-snug transition-colors hover:bg-muted ${
                active ? "text-primary font-semibold bg-primary/5" : "text-foreground"
              }`}
            >
              {b.name}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
