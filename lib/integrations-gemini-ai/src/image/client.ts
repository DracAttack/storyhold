import { GoogleGenAI, Modality } from "@google/genai";

if (!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_GEMINI_BASE_URL must be set. Did you forget to provision the Gemini AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
  );
}

export const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

type ImageModel = "gemini-2.5-flash-image" | "gemini-3-pro-image-preview";

/**
 * Thrown when the model returns a response that contains no image part. This is
 * almost always a content/safety refusal: the model replies with text (an
 * explanation) and `finishReason` / `promptFeedback.blockReason` set, but no
 * inline image data. Carries those fields so callers can branch (e.g. retry
 * with a safer prompt) and logs can explain WHY generation failed.
 */
export class NoImageDataError extends Error {
  readonly finishReason?: string;
  readonly blockReason?: string;
  /** Any text part the model returned in lieu of an image (its refusal note). */
  readonly modelText?: string;

  constructor(detail: { finishReason?: string; blockReason?: string; modelText?: string }) {
    const bits = [
      detail.finishReason ? `finishReason=${detail.finishReason}` : "",
      detail.blockReason ? `blockReason=${detail.blockReason}` : "",
      detail.modelText ? `text=${detail.modelText.slice(0, 200)}` : "",
    ].filter(Boolean);
    super(`No image data in response${bits.length ? ` (${bits.join(", ")})` : ""}`);
    this.name = "NoImageDataError";
    this.finishReason = detail.finishReason;
    this.blockReason = detail.blockReason;
    this.modelText = detail.modelText;
  }
}

export async function generateImage(
  prompt: string,
  options: {
    aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
    model?: ImageModel;
  } = {},
): Promise<{ b64_json: string; mimeType: string }> {
  const config: Record<string, unknown> = {
    responseModalities: [Modality.TEXT, Modality.IMAGE],
  };
  if (options.aspectRatio) {
    config.imageConfig = { aspectRatio: options.aspectRatio };
  }
  const response = await ai.models.generateContent({
    model: options.model ?? "gemini-2.5-flash-image",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config,
  });

  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const imagePart = parts.find(
    (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData,
  );

  if (!imagePart?.inlineData?.data) {
    const modelText = parts
      .map((part: { text?: string }) => part.text)
      .filter((t): t is string => Boolean(t))
      .join(" ")
      .trim();
    throw new NoImageDataError({
      finishReason: candidate?.finishReason as string | undefined,
      blockReason: (response.promptFeedback as { blockReason?: string } | undefined)?.blockReason,
      modelText: modelText || undefined,
    });
  }

  return {
    b64_json: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}

/**
 * Higher-quality image generation using Nano Banana Pro
 * (`gemini-3-pro-image-preview`). A "thinking" model that produces
 * dramatically more photorealistic output than the flash variant — at
 * higher cost and latency. Use for hero/cover images where quality matters.
 */
export async function generatePhotoImage(
  prompt: string,
  options: { aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" } = {},
): Promise<{ b64_json: string; mimeType: string }> {
  return generateImage(prompt, {
    aspectRatio: options.aspectRatio,
    model: "gemini-3-pro-image-preview",
  });
}
