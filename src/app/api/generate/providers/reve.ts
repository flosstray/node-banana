/**
 * REVE Provider for Generate API Route
 *
 * Handles image generation using the REVE native API (api.reve.com).
 * Supports:
 *   - Text-to-image: POST /v1/images/generate { prompt, aspect_ratio }
 *   - Image editing: POST /v1/images/edit { prompt, image_url }
 *
 * REVE model IDs:
 *   - "reve-2/text-to-image"  → text-to-image generation
 *   - "reve-2/image-to-image" → image editing (requires image input)
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";

const REVE_API_BASE = "https://api.reve.com";
const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Possible REVE API response shapes
 */
interface ReveResponseData {
  url?: string;
  b64_json?: string;
  image_url?: string;
}

interface ReveApiResponse {
  // Standard OpenAI-compatible format
  data?: ReveResponseData[];
  // Alternative flat formats
  url?: string;
  image_url?: string;
  images?: Array<{ url?: string; b64_json?: string }>;
  // Error info
  error?: string | { message?: string };
  message?: string;
  detail?: string;
}

/**
 * Upload a base64 image to REVE and get back a URL.
 * REVE's edit endpoint requires an image_url (HTTP URL), not raw base64.
 *
 * We upload via a multipart form to REVE's upload endpoint if available,
 * otherwise we try sending the base64 data URL directly (some REVE variants
 * accept it).
 */
async function resolveImageUrl(
  apiKey: string,
  imageData: string,
  requestId: string
): Promise<string> {
  // If already an HTTP/HTTPS URL, return as-is
  if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
    return imageData;
  }

  // If it's a base64 data URL, try to upload it
  if (imageData.startsWith("data:")) {
    // Try REVE's upload endpoint first
    const uploadUrl = `${REVE_API_BASE}/v1/images/upload`;
    try {
      // Convert base64 to binary
      const base64Data = imageData.split(",")[1];
      const mimeType = imageData.split(";")[0].split(":")[1] || "image/png";
      const binary = Buffer.from(base64Data, "base64");

      // Create form data
      const formData = new FormData();
      const blob = new Blob([binary], { type: mimeType });
      formData.append("image", blob, `image.${mimeType.split("/")[1] || "png"}`);

      const uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (uploadResp.ok) {
        const uploadResult = await uploadResp.json();
        const uploadedUrl = uploadResult?.url || uploadResult?.image_url || uploadResult?.data?.[0]?.url;
        if (uploadedUrl && typeof uploadedUrl === "string") {
          console.log(`[API:${requestId}] REVE image uploaded: ${uploadedUrl.substring(0, 80)}`);
          return uploadedUrl;
        }
      }
    } catch (uploadErr) {
      console.warn(`[API:${requestId}] REVE image upload failed, will try sending base64 directly:`, uploadErr);
    }

    // Fallback: return the base64 data URL directly — some REVE variants accept it
    return imageData;
  }

  return imageData;
}

/**
 * Extract the output URL or base64 from a REVE API response.
 */
function extractOutput(response: ReveApiResponse): { url?: string; b64?: string } | null {
  // Format 1: { data: [{ url, b64_json }] }
  if (response.data && Array.isArray(response.data) && response.data.length > 0) {
    const item = response.data[0];
    return { url: item.url || item.image_url, b64: item.b64_json ?? undefined };
  }

  // Format 2: { images: [{ url, b64_json }] }
  if (response.images && Array.isArray(response.images) && response.images.length > 0) {
    const item = response.images[0];
    return { url: item.url, b64: item.b64_json ?? undefined };
  }

  // Format 3: flat { url } or { image_url }
  if (response.url) return { url: response.url };
  if (response.image_url) return { url: response.image_url };

  return null;
}

/**
 * Fetch an image from a URL and convert to base64 data URL.
 */
async function fetchAsBase64(url: string, requestId: string): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`Failed to fetch REVE output: HTTP ${resp.status}`);

  const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
  if (contentLength && contentLength > MAX_MEDIA_SIZE) {
    throw new Error(`REVE output too large: ${(contentLength / 1024 / 1024).toFixed(0)}MB`);
  }

  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength > MAX_MEDIA_SIZE) {
    throw new Error(`REVE output too large: ${(buffer.byteLength / 1024 / 1024).toFixed(0)}MB`);
  }

  const rawContentType = resp.headers.get("content-type") || "image/png";
  const mime = rawContentType.split(";")[0].trim();
  const base64 = Buffer.from(buffer).toString("base64");

  console.log(`[API:${requestId}] REVE output fetched: ${mime}, ${(buffer.byteLength / 1024).toFixed(0)}KB`);
  return `data:${mime};base64,${base64}`;
}

/**
 * Generate image using REVE API.
 * Routes to text-to-image or image-editing based on model ID and available inputs.
 */
export async function generateWithReve(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  const modelId = input.model.id;
  const isEditModel =
    modelId.includes("image-to-image") ||
    modelId.includes("edit") ||
    !!input.dynamicInputs?.image_url ||
    (input.images && input.images.length > 0);

  console.log(
    `[API:${requestId}] REVE generation — Model: ${modelId}, Mode: ${isEditModel ? "edit" : "text-to-image"}, Prompt: ${input.prompt.substring(0, 80)}`
  );

  // ── Build request payload ──────────────────────────────────────────────────

  const prompt = input.prompt || "";

  // Resolve aspect_ratio from parameters
  const aspectRatio = (input.parameters?.aspect_ratio as string) || "1:1";

  // Resolve negative_prompt from parameters
  const negativePrompt = (input.parameters?.negative_prompt as string) || undefined;

  let endpoint: string;
  let body: Record<string, unknown>;

  if (isEditModel) {
    // ── Image editing ──────────────────────────────────────────────────────
    endpoint = `${REVE_API_BASE}/v1/images/edit`;

    // Prefer dynamic image_url handle, fall back to first image in array
    let rawImageInput: string | undefined;
    if (input.dynamicInputs?.image_url) {
      rawImageInput = Array.isArray(input.dynamicInputs.image_url)
        ? input.dynamicInputs.image_url[0]
        : input.dynamicInputs.image_url;
    } else if (input.images && input.images.length > 0) {
      rawImageInput = input.images[0];
    }

    if (!rawImageInput) {
      return { success: false, error: "REVE image editing requires an image input" };
    }

    const imageUrl = await resolveImageUrl(apiKey, rawImageInput, requestId);

    body = {
      prompt,
      image_url: imageUrl,
    };
    if (negativePrompt) body.negative_prompt = negativePrompt;
  } else {
    // ── Text-to-image ──────────────────────────────────────────────────────
    endpoint = `${REVE_API_BASE}/v1/images/generate`;

    body = {
      prompt,
      aspect_ratio: aspectRatio,
    };
    if (negativePrompt) body.negative_prompt = negativePrompt;
  }

  // Merge any remaining user parameters (except ones we've already handled)
  if (input.parameters) {
    const handled = new Set(["aspect_ratio", "negative_prompt"]);
    for (const [key, val] of Object.entries(input.parameters)) {
      if (!handled.has(key) && val !== undefined && val !== null && val !== "") {
        body[key] = val;
      }
    }
  }

  console.log(`[API:${requestId}] REVE endpoint: ${endpoint}`);
  console.log(`[API:${requestId}] REVE payload keys: ${Object.keys(body).join(", ")}`);

  // ── Call API ───────────────────────────────────────────────────────────────

  let apiResponse: Response;
  try {
    apiResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5 * 60_000), // 5 min
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    console.error(`[API:${requestId}] REVE fetch error: ${msg}`);
    return { success: false, error: `REVE: ${msg}` };
  }

  // ── Handle errors ──────────────────────────────────────────────────────────

  if (!apiResponse.ok) {
    let errorDetail = `HTTP ${apiResponse.status}`;
    try {
      const errJson: ReveApiResponse = await apiResponse.json();
      if (typeof errJson.error === "string") errorDetail = errJson.error;
      else if (typeof errJson.error === "object") errorDetail = errJson.error?.message || errorDetail;
      else if (errJson.message) errorDetail = errJson.message;
      else if (errJson.detail) errorDetail = errJson.detail;
    } catch {
      // Keep HTTP status message
    }

    console.error(`[API:${requestId}] REVE API error: ${apiResponse.status} — ${errorDetail}`);

    if (apiResponse.status === 401) {
      return { success: false, error: "REVE: Invalid API key. Check your REVE API key in Settings." };
    }
    if (apiResponse.status === 429) {
      return { success: false, error: "REVE: Rate limit reached. Please wait and try again." };
    }

    return { success: false, error: `REVE: ${errorDetail}` };
  }

  // ── Parse response ─────────────────────────────────────────────────────────

  let responseJson: ReveApiResponse;
  try {
    responseJson = await apiResponse.json();
  } catch {
    return { success: false, error: "REVE: Invalid JSON response" };
  }

  console.log(`[API:${requestId}] REVE response keys: ${Object.keys(responseJson).join(", ")}`);

  const output = extractOutput(responseJson);
  if (!output) {
    console.error(`[API:${requestId}] REVE unexpected response shape:`, JSON.stringify(responseJson).substring(0, 300));
    return { success: false, error: "REVE: No image in response" };
  }

  // ── Return result ──────────────────────────────────────────────────────────

  let imageData: string;

  if (output.b64 && output.b64.length > 0) {
    // Already have base64 — wrap in data URL if needed
    imageData = output.b64.startsWith("data:")
      ? output.b64
      : `data:image/png;base64,${output.b64}`;
    console.log(`[API:${requestId}] SUCCESS — REVE returned base64 image`);
  } else if (output.url) {
    // Fetch the URL and convert to base64
    try {
      imageData = await fetchAsBase64(output.url, requestId);
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return { success: false, error: `REVE: ${msg}` };
    }
  } else {
    return { success: false, error: "REVE: No image URL or data in response" };
  }

  return {
    success: true,
    outputs: [{ type: "image", data: imageData, url: output.url }],
  };
}
