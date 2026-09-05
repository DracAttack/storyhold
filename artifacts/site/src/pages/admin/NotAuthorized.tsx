import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

export default function NotAuthorized() {
  const { signOut } = useAuth();
  const [, setLocation] = useLocation();

  const handleSignOut = async () => {
    await signOut();
    setLocation("/admin/login");
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-md p-8 space-y-4 text-center">
        <h1 className="font-serif text-2xl font-bold">Not authorized</h1>
        <p className="text-sm text-muted-foreground">
          This account does not have access to the Storyhold owner workspace.
        </p>
        <Button variant="outline" className="w-full" onClick={handleSignOut}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}
