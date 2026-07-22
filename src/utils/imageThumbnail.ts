/**
 * Generates a lower-resolution JPEG thumbnail from a base64 image data URL.
 * Used for adaptive image resolution — rendering smaller images when nodes
 * are small in the viewport.
 */
type ThumbnailWorkerResponse =
  | { id: number; thumbnail: string }
  | { id: number; error: string };

type PendingThumbnailRequest = {
  resolve: (thumbnail: string) => void;
  originalDataUrl: string;
};

let thumbnailWorker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingThumbnailRequest>();

function canUseThumbnailWorker(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined"
  );
}

function getThumbnailWorker(): Worker | null {
  if (!canUseThumbnailWorker()) return null;
  if (thumbnailWorker) return thumbnailWorker;

  try {
    thumbnailWorker = new Worker(
      new URL("../workers/thumbnailWorker.ts", import.meta.url),
      { type: "module" }
    );

    thumbnailWorker.onmessage = (
      event: MessageEvent<ThumbnailWorkerResponse>
    ) => {
      const { id } = event.data;
      const pending = pendingRequests.get(id);
      if (!pending) return;

      pendingRequests.delete(id);
      if ("thumbnail" in event.data) {
        pending.resolve(event.data.thumbnail);
        return;
      }

      pending.resolve(pending.originalDataUrl);
    };

    thumbnailWorker.onerror = () => {
      resolveAllPendingWithOriginals();
      thumbnailWorker?.terminate();
      thumbnailWorker = null;
    };

    thumbnailWorker.onmessageerror = () => {
      resolveAllPendingWithOriginals();
      thumbnailWorker?.terminate();
      thumbnailWorker = null;
    };
  } catch {
    thumbnailWorker = null;
  }

  return thumbnailWorker;
}

function resolveAllPendingWithOriginals(): void {
  pendingRequests.forEach((pending) => {
    pending.resolve(pending.originalDataUrl);
  });
  pendingRequests.clear();
}

export async function generateThumbnail(
  base64DataUrl: string,
  maxDim: number = 256,
  quality: number = 0.6
): Promise<string> {
  if (!base64DataUrl) return base64DataUrl;

  const worker = getThumbnailWorker();
  if (worker) {
    return new Promise((resolve) => {
      const id = nextRequestId++;
      pendingRequests.set(id, {
        resolve,
        originalDataUrl: base64DataUrl,
      });

      try {
        worker.postMessage({
          id,
          dataUrl: base64DataUrl,
          maxDim,
          quality,
        });
      } catch {
        pendingRequests.delete(id);
        resolve(base64DataUrl);
      }
    });
  }

  return generateThumbnailOnMainThread(base64DataUrl, maxDim, quality);
}

function generateThumbnailOnMainThread(
  base64DataUrl: string,
  maxDim: number,
  quality: number
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;

      // Skip if already small enough
      if (w <= maxDim && h <= maxDim) {
        resolve(base64DataUrl);
        return;
      }

      // Calculate scaled dimensions preserving aspect ratio
      const scale = Math.min(maxDim / w, maxDim / h);
      const newW = Math.round(w * scale);
      const newH = Math.round(h * scale);

      const canvas = document.createElement("canvas");
      canvas.width = newW;
      canvas.height = newH;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64DataUrl);
        return;
      }

      ctx.drawImage(img, 0, 0, newW, newH);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(base64DataUrl);
    img.src = base64DataUrl;
  });
}
