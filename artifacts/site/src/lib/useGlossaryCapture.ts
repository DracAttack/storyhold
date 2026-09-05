import { useContext } from "react";
import { Ctx, type GlosaryCaptureCtx } from "@/lib/glossaryCaptureContext";

export function useGlossaryCapture(): GlosaryCaptureCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGlossaryCapture must be used inside GlosaryCaptureProvider");
  return ctx;
}
