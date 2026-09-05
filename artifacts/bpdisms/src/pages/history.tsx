import { Header } from "@/components/layout/Header";
import { PostCard } from "@/components/queue/PostCard";
import { usePosts } from "@/hooks/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Archive } from "lucide-react";

export default function HistoryPage() {
  const { data: posts, isLoading } = usePosts("history");

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />

      <main className="flex-1 container max-w-screen-lg px-4 md:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground" data-testid="text-history-title">History</h1>
          <p className="text-muted-foreground mt-1">Everything that has already gone out the door.</p>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : posts && posts.length > 0 ? (
          <div className="flex flex-col gap-4" data-testid="list-history">
            {posts.map((post: any) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        ) : (
          <div className="border-2 border-dashed border-border rounded-xl p-12 flex flex-col items-center justify-center text-center min-h-[300px]">
            <Archive className="w-10 h-10 text-muted-foreground mb-4" />
            <p className="text-lg font-semibold text-foreground">Nothing in the books yet.</p>
            <p className="text-muted-foreground mt-1">Once posts go live, they'll show up here.</p>
          </div>
        )}
      </main>
    </div>
  );
}
