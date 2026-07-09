type ThumbnailRequest = {
  id: number;
  dataUrl: string;
  maxDim: number;
  quality: number;
};

type ThumbnailResponse =
  | { id: number; thumbnail: string }
  | { id: number; error: string };

type WorkerGlobal = {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<ThumbnailRequest>) => void
  ) => void;
  postMessage: (message: ThumbnailResponse) => void;
};

const workerGlobal = globalThis as unknown as WorkerGlobal;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read thumbnail blob"));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read thumbnail blob"));
    reader.readAsDataURL(blob);
  });
}

async function createThumbnail(
  dataUrl: string,
  maxDim: number,
  quality: number
): Promise<string> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  try {
    const { width: w, height: h } = bitmap;

    // Match the main-thread behavior: already-small images are returned as-is.
    if (w <= maxDim && h <= maxDim) {
      return dataUrl;
    }

    const scale = Math.min(maxDim / w, maxDim / h);
    const newW = Math.round(w * scale);
    const newH = Math.round(h * scale);

    const canvas = new OffscreenCanvas(newW, newH);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return dataUrl;
    }

    ctx.drawImage(bitmap, 0, 0, newW, newH);
    const thumbnailBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality,
    });

    return blobToDataUrl(thumbnailBlob);
  } finally {
    bitmap.close();
  }
}

workerGlobal.addEventListener("message", (event) => {
  const { id, dataUrl, maxDim, quality } = event.data;

  createThumbnail(dataUrl, maxDim, quality)
    .then((thumbnail) => {
      workerGlobal.postMessage({ id, thumbnail });
    })
    .catch((error: unknown) => {
      workerGlobal.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});

export {};
