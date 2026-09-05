import type { CSSProperties, SyntheticEvent } from "react";
import {
  resolveImage,
  handleImageError,
  withImageParams,
  buildSrcSet,
} from "@/lib/heroImage";

type Props = {
  /** Raw image value from the API/data (resolved internally). */
  src: string;
  alt: string;
  /** Candidate widths for the responsive `srcSet`. */
  widths: number[];
  /** `sizes` attribute describing the rendered width at each breakpoint. */
  sizes: string;
  /**
   * Intrinsic width/height (in px) emitted as `width`/`height` attributes so the
   * browser can reserve space and avoid layout shift (CLS). Their ratio should
   * match the rendered aspect ratio. CSS (e.g. `object-cover w-full h-full`)
   * still controls the actual rendered size, so responsive behavior is intact.
   */
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
  /** Above-the-fold image: load eagerly with high fetch priority (LCP). */
  priority?: boolean;
  draggable?: boolean;
  ariaHidden?: boolean;
  /** Hide the element on error instead of showing the placeholder. */
  hideOnError?: boolean;
};

/**
 * <img> wrapper that requests appropriately-sized, WebP-when-supported variants
 * from the public-object transform route. Lazy-loads by default; pass
 * `priority` for the single above-the-fold hero. Falls back cleanly for
 * non-transformable sources (external URLs, bundled static files).
 */
export default function ResponsiveImage({
  src,
  alt,
  widths,
  sizes,
  width,
  height,
  className,
  style,
  priority = false,
  draggable,
  ariaHidden,
  hideOnError = false,
}: Props) {
  const resolved = resolveImage(src);
  const maxWidth = widths.length ? Math.max(...widths) : undefined;
  const srcSet = buildSrcSet(resolved, widths);

  const onError = hideOnError
    ? (e: SyntheticEvent<HTMLImageElement>) => {
        e.currentTarget.style.display = "none";
      }
    : handleImageError;

  return (
    <img
      src={withImageParams(resolved, maxWidth)}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      width={width}
      height={height}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      onError={onError}
      className={className}
      style={style}
      draggable={draggable}
      aria-hidden={ariaHidden}
    />
  );
}
