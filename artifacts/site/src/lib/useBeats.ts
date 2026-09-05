import { useQuery } from "@tanstack/react-query";

export type Beat = {
  slug: string;
  name: string;
  description: string | null;
  seoDescription: string | null;
  heroImageUrl: string | null;
};

const apiBase = (() => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/api`;
})();

async function fetchBeats(): Promise<Beat[]> {
  const res = await fetch(`${apiBase}/public/beats`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Failed to load beats: ${res.status}`);
  const data = (await res.json()) as { items: Beat[] };
  return data.items;
}

export function useBeats() {
  const query = useQuery({
    queryKey: ["public", "beats"],
    queryFn: fetchBeats,
    staleTime: 5 * 60_000,
  });
  return {
    beats: query.data ?? [],
    isLoading: query.isLoading,
  };
}
