/**
 * Shared utility for downloading media (images, video, audio) from nodes.
 * Handles both data URLs (base64) and HTTP URLs.
 */

/** Infer a file extension from a data URL's MIME type. */
function extensionFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;,]+)/);
  if (!match) return "bin";
  const mime = match[1];
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
  };
  return map[mime] ?? mime.split("/")[1] ?? "bin";
}

/** Infer a file extension from a URL path. */
function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase();
    if (ext && ext.length <= 5 && ext.length >= 2) return ext;
  } catch {
    // not a valid URL
  }
  return "bin";
}

export type MediaType = "image" | "video" | "audio";

/**
 * Download media content via an anchor-click approach.
 *
 * @param src       - Data URL (base64) or HTTP URL of the media
 * @param mediaType - Hint for file extension when MIME detection fails
 * @param filename  - Optional custom filename (without extension)
 */
export async function downloadMedia(
  src: string,
  mediaType: MediaType = "image",
  filename?: string,
): Promise<void> {
  const fallbackExt: Record<MediaType, string> = {
    image: "png",
    video: "mp4",
    audio: "mp3",
  };

  const isHttp = src.startsWith("http://") || src.startsWith("https://");
  const ext = isHttp
    ? extensionFromUrl(src)
    : extensionFromDataUrl(src);
  const finalExt = ext === "bin" ? fallbackExt[mediaType] : ext;
  const finalName = filename
    ? `${filename}.${finalExt}`
    : `${mediaType}-${Date.now()}.${finalExt}`;

  if (isHttp) {
    try {
      const response = await fetch(src);
      if (!response.ok) {
        console.error(`Failed to download: ${response.status} ${response.statusText}`);
        return;
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      triggerDownload(blobUrl, finalName);
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error("Failed to download:", error);
    }
    return;
  }

  // Data URL — direct download
  triggerDownload(src, finalName);
}

function triggerDownload(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Copy an image to the system clipboard.
 *
 * Browsers only reliably accept `image/png` on the clipboard, so non-PNG
 * sources are re-encoded via canvas. Handles data URLs and (CORS-permitting)
 * HTTP URLs. Passing a Promise to ClipboardItem preserves the user-gesture
 * requirement across the async encode.
 *
 * @returns true on success, false if unsupported or the write failed.
 */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    console.error("Image clipboard copy is not supported in this browser");
    return false;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": toPngBlob(src) }),
    ]);
    return true;
  } catch (error) {
    console.error("Failed to copy image to clipboard:", error);
    return false;
  }
}

/** Fetch/convert an image src to a PNG blob (re-encoding only when needed). */
async function toPngBlob(src: string): Promise<Blob> {
  const blob = await (await fetch(src)).blob();
  if (blob.type === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Could not get canvas context"));
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (out) => (out ? resolve(out) : reject(new Error("Canvas toBlob returned null"))),
          "image/png",
        );
      };
      img.onerror = () => reject(new Error("Failed to load image for clipboard copy"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
