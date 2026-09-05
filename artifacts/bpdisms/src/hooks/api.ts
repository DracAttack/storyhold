import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// This app is served under a base path (e.g. /bpdisms/), so root-relative
// "/api/..." URLs would escape the artifact's prefix and hit the wrong
// service. Rewrite them onto the app's own API mount (BASE_URL + "api").
const API_BASE = `${import.meta.env.BASE_URL}api`;

const fetcher = async (url: string, options?: RequestInit) => {
  const res = await fetch(url.replace(/^\/api/, API_BASE), options);
  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText || "An error occurred";
    try {
      const parsed = JSON.parse(errorText);
      if (parsed && typeof parsed.error === "string") {
        message = parsed.error;
      }
    } catch {
      // not JSON, use raw text
    }
    throw new Error(message);
  }
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
};

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => fetcher("/api/me"),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function usePostStats() {
  return useQuery({
    queryKey: ["postStats"],
    queryFn: () => fetcher("/api/posts/stats"),
  });
}

export function usePosts(status: string = "all") {
  return useQuery({
    queryKey: ["posts", status],
    queryFn: () => fetcher(`/api/posts?status=${status}`),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => fetcher("/api/settings"),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => fetcher("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function usePostingSlots() {
  return useQuery({
    queryKey: ["postingSlots"],
    queryFn: () => fetcher("/api/posting-slots"),
  });
}

export function useCreatePostingSlot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => fetcher("/api/posting-slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["postingSlots"] });
    },
  });
}

export function useUpdatePostingSlot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string, data: any }) => fetcher(`/api/posting-slots/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["postingSlots"] });
    },
  });
}

export function useDeletePostingSlot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/api/posting-slots/${id}`, {
      method: "DELETE",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["postingSlots"] });
    },
  });
}

export function useDeletePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/api/posts/${id}`, {
      method: "DELETE",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["posts"] });
      queryClient.invalidateQueries({ queryKey: ["postStats"] });
    },
  });
}

export function useUpdatePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      caption,
      scheduledAtLocal,
    }: {
      id: string | number;
      caption?: string;
      scheduledAtLocal?: string;
    }) =>
      fetcher(`/api/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(caption !== undefined ? { caption } : {}),
          ...(scheduledAtLocal !== undefined ? { scheduledAtLocal } : {}),
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["posts"] });
      queryClient.invalidateQueries({ queryKey: ["postStats"] });
    },
  });
}

export function useRetryPost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/api/posts/${id}/retry`, {
      method: "POST",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["posts"] });
      queryClient.invalidateQueries({ queryKey: ["postStats"] });
    },
  });
}

export function useZernioAnalytics() {
  return useQuery({
    queryKey: ["zernio-analytics"],
    queryFn: () => fetcher("/api/zernio/analytics"),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useZernioBestTimes() {
  return useQuery({
    queryKey: ["zernio-best-times"],
    queryFn: () => fetcher("/api/zernio/best-times"),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useZernioAccounts() {
  return useQuery({
    queryKey: ["zernio-accounts"],
    queryFn: () => fetcher("/api/zernio/accounts"),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useTestZernio() {
  return useMutation({
    mutationFn: () => fetcher("/api/zernio/test", { method: "POST" }),
  });
}

export function useQueuePosts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => fetcher("/api/posts/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["posts"] });
      queryClient.invalidateQueries({ queryKey: ["postStats"] });
    },
  });
}

export const uploadFile = async (file: File) => {
  const { uploadURL, objectPath, imageUrl } = await fetcher("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
  });

  await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });

  return { imageUrl, objectPath, originalFilename: file.name };
};
