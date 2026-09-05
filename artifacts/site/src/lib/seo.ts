import { useEffect } from "react";

export interface SeoOptions {
  title: string;
  socialTitle?: string;
  description?: string;
  canonicalPath?: string;
  image?: string;
  type?: "website" | "article";
  jsonLd?: Record<string, unknown> | null;
  noindex?: boolean;
  imageWidth?: number;
  imageHeight?: number;
  imageAlt?: string;
}

const SITE_NAME = "Storyhold";
const MANAGED_ATTR = "data-seo-managed";
const ROBOTS_INDEXABLE =
  "max-image-preview:large, max-snippet:-1, max-video-preview:-1";

export function getSiteOrigin(): string {
  const configured = (
    import.meta.env.VITE_SITE_URL as string | undefined
  )?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "http://127.0.0.1:3000";
}

function upsertMeta(selector: string, attrs: Record<string, string>) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(MANAGED_ATTR, "true");
    document.head.appendChild(element);
  }
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value);
  }
}

function removeMeta(selector: string) {
  document.head.querySelector(selector)?.remove();
}

function upsertCanonical(href: string) {
  let element =
    document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement("link");
    element.rel = "canonical";
    element.setAttribute(MANAGED_ATTR, "true");
    document.head.appendChild(element);
  }
  element.href = href;
}

export function buildSiteGraph(origin: string): Record<string, unknown> {
  const organizationId = `${origin}/#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: SITE_NAME,
        url: `${origin}/`,
        logo: {
          "@type": "ImageObject",
          url: `${origin}/storyhold-mark.svg`,
        },
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: SITE_NAME,
        url: `${origin}/`,
        publisher: { "@id": organizationId },
      },
    ],
  };
}

function setJsonLd(data: Record<string, unknown> | null | undefined) {
  document.getElementById("seo-jsonld")?.remove();
  if (!data) return;
  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.id = "seo-jsonld";
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
}

export function useSeo(options: SeoOptions): void {
  const {
    title,
    socialTitle,
    description,
    canonicalPath,
    image,
    imageWidth,
    imageHeight,
    imageAlt,
    type = "website",
    jsonLd,
    noindex = false,
  } = options;

  useEffect(() => {
    const fullTitle = title.includes(SITE_NAME)
      ? title
      : `${title} | ${SITE_NAME}`;
    const social = (socialTitle ?? "").trim() || title;
    const fullSocialTitle = social.includes(SITE_NAME)
      ? social
      : `${social} | ${SITE_NAME}`;
    const origin = getSiteOrigin();
    const path = canonicalPath ?? window.location.pathname;
    const canonical = `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
    const absoluteImage = image
      ? image.startsWith("/")
        ? `${origin}${image}`
        : image
      : null;

    document.title = fullTitle;
    upsertCanonical(canonical);
    if (description) {
      upsertMeta('meta[name="description"]', {
        name: "description",
        content: description,
      });
    }
    upsertMeta('meta[property="og:locale"]', {
      property: "og:locale",
      content: "en_US",
    });
    upsertMeta('meta[property="og:title"]', {
      property: "og:title",
      content: fullSocialTitle,
    });
    upsertMeta('meta[property="og:type"]', {
      property: "og:type",
      content: type,
    });
    upsertMeta('meta[property="og:url"]', {
      property: "og:url",
      content: canonical,
    });
    upsertMeta('meta[property="og:site_name"]', {
      property: "og:site_name",
      content: SITE_NAME,
    });
    if (description) {
      upsertMeta('meta[property="og:description"]', {
        property: "og:description",
        content: description,
      });
    }

    if (absoluteImage) {
      const alt = imageAlt ?? fullTitle;
      upsertMeta('meta[property="og:image"]', {
        property: "og:image",
        content: absoluteImage,
      });
      upsertMeta('meta[property="og:image:alt"]', {
        property: "og:image:alt",
        content: alt,
      });
      if (/^https:\/\//i.test(absoluteImage)) {
        upsertMeta('meta[property="og:image:secure_url"]', {
          property: "og:image:secure_url",
          content: absoluteImage,
        });
      } else {
        removeMeta('meta[property="og:image:secure_url"]');
      }
      if (imageWidth) {
        upsertMeta('meta[property="og:image:width"]', {
          property: "og:image:width",
          content: String(imageWidth),
        });
      }
      if (imageHeight) {
        upsertMeta('meta[property="og:image:height"]', {
          property: "og:image:height",
          content: String(imageHeight),
        });
      }
      upsertMeta('meta[property="snapchat:sticker"]', {
        property: "snapchat:sticker",
        content: `${absoluteImage}${absoluteImage.includes("?") ? "&" : "?"}snap=1`,
      });
      upsertMeta('meta[name="twitter:image"]', {
        name: "twitter:image",
        content: absoluteImage,
      });
      upsertMeta('meta[name="twitter:image:alt"]', {
        name: "twitter:image:alt",
        content: alt,
      });
    } else {
      for (const selector of [
        'meta[property="og:image"]',
        'meta[property="og:image:secure_url"]',
        'meta[property="og:image:alt"]',
        'meta[property="og:image:width"]',
        'meta[property="og:image:height"]',
        'meta[property="snapchat:sticker"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:alt"]',
      ]) {
        removeMeta(selector);
      }
    }

    upsertMeta('meta[name="twitter:card"]', {
      name: "twitter:card",
      content: absoluteImage ? "summary_large_image" : "summary",
    });
    upsertMeta('meta[name="twitter:title"]', {
      name: "twitter:title",
      content: fullSocialTitle,
    });
    if (description) {
      upsertMeta('meta[name="twitter:description"]', {
        name: "twitter:description",
        content: description,
      });
    }
    upsertMeta('meta[name="robots"]', {
      name: "robots",
      content: noindex ? "noindex, nofollow" : ROBOTS_INDEXABLE,
    });
    setJsonLd(
      jsonLd !== undefined
        ? jsonLd
        : type === "website"
          ? buildSiteGraph(origin)
          : null,
    );

    return () => {
      setJsonLd(null);
      upsertMeta('meta[name="robots"]', {
        name: "robots",
        content: ROBOTS_INDEXABLE,
      });
    };
  }, [
    title,
    socialTitle,
    description,
    canonicalPath,
    image,
    imageWidth,
    imageHeight,
    imageAlt,
    type,
    jsonLd,
    noindex,
  ]);
}
