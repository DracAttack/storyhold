import { Link } from "wouter";
import { Pencil } from "lucide-react";
import { useAuth } from "@/lib/auth";

// Admin-only quick-edit shortcut shown next to an article's read-time. It is
// purely client-side and auth-gated, so public/SEO (server-rendered) visitors
// never see it and it never appears in the server-rendered HTML.
export default function AdminEditLink({
  articleId,
  className,
}: {
  articleId: string;
  className?: string;
}) {
  const { email } = useAuth();
  if (!email) return null;

  return (
    <Link
      href={`/admin/articles/${articleId}`}
      onClick={(e) => e.stopPropagation()}
      title="Edit this article"
      aria-label="Edit this article"
      className={`inline-flex items-center gap-1 text-primary hover:text-primary/80 transition-colors ${className ?? ""}`}
    >
      <Pencil className="h-3 w-3" />
      Edit
    </Link>
  );
}
