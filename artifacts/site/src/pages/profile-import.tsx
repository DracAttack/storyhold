import { useState } from "react";
import { BookPlus, Sparkles } from "lucide-react";
import { ManuscriptImporter } from "@/components/customer/manuscript-importer";
import { QuickstartCreator } from "@/components/customer/quickstart-creator";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { useSeo } from "@/lib/seo";

export default function ProfileImport() {
  const search = new URLSearchParams(window.location.search);
  const targetWorldId = search.get("world") ?? "";
  const referenceMode = search.get("reference") === "1";
  const [mode, setMode] = useState<"idea" | "sources">(
    targetWorldId || search.get("mode") === "sources" ? "sources" : "idea",
  );
  useSeo({
    title: targetWorldId ? "Add sources" : "Create a world",
    description: "Create a private Storyhold world from an idea or your writing.",
    canonicalPath: "/profile/import",
    noindex: true,
  });

  return (
    <ProfileFrame>
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          {referenceMode ? "Lorekeeper Vault" : targetWorldId ? "Expand existing canon" : "Inside your profile"}
        </p>
        <h1 className="mt-3 font-serif text-4xl font-bold tracking-tight sm:text-5xl">
          {referenceMode
            ? "Upload Outside References"
            : targetWorldId
              ? "Add to This World"
              : mode === "idea"
                ? "Start a New Adventure"
                : "Turn Your Writing into a Playable World"}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
          {referenceMode
            ? "Add background material Lorekeeper may consult without treating it as direct story canon."
            : targetWorldId
            ? "Add books, sheets, notes, and rules without creating another world."
            : mode === "idea"
              ? "Create an original world, choose who you will play, and begin from zero with Storyhold's RPG system."
              : "Upload a manuscript and let Lorekeeper build the people, places, history, and canon you can explore through play."}
        </p>
      </div>
      {!targetWorldId ? (
        <div className="mb-6 grid grid-cols-2 gap-2 rounded-2xl border border-white/8 bg-black/20 p-1.5 sm:max-w-xl">
          <button
            type="button"
            onClick={() => setMode("idea")}
            className={`flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${mode === "idea" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Sparkles className="mr-2 h-4 w-4" /> Start New Adventure
          </button>
          <button
            type="button"
            onClick={() => setMode("sources")}
            className={`flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${mode === "sources" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <BookPlus className="mr-2 h-4 w-4" /> Play My Writing
          </button>
        </div>
      ) : null}
      {mode === "idea" && !targetWorldId ? (
        <QuickstartCreator />
      ) : (
        <ManuscriptImporter targetWorldId={targetWorldId} referenceMode={referenceMode} />
      )}
    </ProfileFrame>
  );
}
