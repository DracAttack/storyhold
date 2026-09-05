import { useState } from "react";
import { Header } from "@/components/layout/Header";
import { UploadArea } from "@/components/queue/UploadArea";
import { PostCard } from "@/components/queue/PostCard";
import { usePostStats, usePosts } from "@/hooks/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FileEdit, CalendarClock, Send, AlertTriangle, Ghost } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function QueuePage() {
  const [statusFilter, setStatusFilter] = useState("all");
  
  const { data: stats, isLoading: statsLoading } = usePostStats();
  const { data: posts, isLoading: postsLoading } = usePosts(statusFilter);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      
      <main className="flex-1 container max-w-screen-2xl px-4 md:px-8 py-8">
        {/* Status Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard 
            title="Drafts" 
            value={stats?.drafts} 
            loading={statsLoading} 
            icon={<FileEdit className="w-4 h-4 text-muted-foreground" />} 
          />
          <StatCard 
            title="Scheduled" 
            value={stats?.scheduled} 
            loading={statsLoading} 
            icon={<CalendarClock className="w-4 h-4 text-primary" />} 
          />
          <StatCard 
            title="Posted" 
            value={stats?.posted} 
            loading={statsLoading} 
            icon={<Send className="w-4 h-4 text-green-500" />} 
          />
          <StatCard 
            title="Failed" 
            value={stats?.failed} 
            loading={statsLoading} 
            icon={<AlertTriangle className="w-4 h-4 text-destructive" />} 
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Upload */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            <div>
              <h2 className="text-xl font-bold text-foreground mb-4">Add Memes</h2>
              <UploadArea />
            </div>
          </div>

          {/* Right Column: Queue */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl font-bold text-foreground">Queue</h2>
              
              <Tabs value={statusFilter} onValueChange={setStatusFilter} className="w-auto">
                <TabsList className="bg-muted">
                  <TabsTrigger value="all" data-testid="tab-filter-all">All</TabsTrigger>
                  <TabsTrigger value="upcoming" data-testid="tab-filter-upcoming">Upcoming</TabsTrigger>
                  <TabsTrigger value="posted" data-testid="tab-filter-posted">Posted</TabsTrigger>
                  <TabsTrigger value="failed" data-testid="tab-filter-failed">Failed</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {postsLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => (
                  <Skeleton key={i} className="h-40 w-full rounded-xl bg-card border border-border" />
                ))}
              </div>
            ) : posts?.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center border-2 border-dashed border-border rounded-xl bg-card/50">
                <Ghost className="w-12 h-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium text-foreground">Your queue is suspiciously peaceful.</h3>
                <p className="text-muted-foreground mt-2 max-w-sm">Upload some memes and let the conveyor belt begin.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {posts?.map((post: any) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function StatCard({ title, value, loading, icon }: { title: string, value?: number, loading: boolean, icon: React.ReactNode }) {
  return (
    <Card className="bg-card border-border shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4 sm:px-6">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent className="pb-4 px-4 sm:px-6">
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className="text-2xl sm:text-3xl font-bold">{value || 0}</div>
        )}
      </CardContent>
    </Card>
  );
}
