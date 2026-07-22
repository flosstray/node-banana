/**
 * Correct a media content-type when a provider serves an SVG with a generic
 * type. Some providers (e.g. fal's `recraft/vectorize` and `image2svg`) return
 * `.svg` outputs as `application/octet-stream`, which will not render in an
 * `<img>` (`data:application/octet-stream;...`). When the output is actually
 * SVG — by URL extension or by sniffing the leading bytes — this returns
 * `image/svg+xml`; otherwise the original content-type is returned unchanged.
 */
export function correctSvgContentType(
  contentType: string,
  url: string,
  buffer: ArrayBuffer,
): string {
  // Trust already-recognized concrete media types.
  if (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/")
  ) {
    return contentType;
  }

  const path = url.toLowerCase().split(/[?#]/)[0];
  if (path.endsWith(".svg")) return "image/svg+xml";

  // Fall back to sniffing the first bytes for an SVG/XML signature.
  const head = new TextDecoder()
    .decode(new Uint8Array(buffer.slice(0, 256)))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }

  return contentType;
}
