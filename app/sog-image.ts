/**
 * SOGのストリーム画像を1バイトも壊さずに読み出すためのデコーダ。
 *
 * Canvas 2Dはアルファ乗算済みで画素を保持するため、`getImageData` を通すと
 * 不透明度の低い画素のRGBが失われる。SOGはアルファに不透明度や量子化モードを
 * 詰めているので、WebGL2のテクスチャへ非乗算のまま上げてreadPixelsで取り出す。
 */
import type { ImagePixels } from "./sog-optimizer";

export type ImageReader = {
  read(bytes: Uint8Array, filename: string): Promise<ImagePixels>;
  dispose(): void;
};

const MIME_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export function mimeTypeFor(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/** 最適化に必要なAPIが揃っているか。足りない理由はそのままUIに出す。 */
export function optimizationUnsupportedReason(): string | null {
  if (typeof OffscreenCanvas === "undefined") return "このブラウザはOffscreenCanvasに対応していません。";
  if (typeof createImageBitmap === "undefined") return "このブラウザはcreateImageBitmapに対応していません。";
  if (typeof CompressionStream === "undefined") return "このブラウザはCompressionStreamに対応していません。";
  try {
    const probe = new OffscreenCanvas(1, 1).getContext("webgl2");
    if (!probe) return "このブラウザではWebGL2を利用できません。";
    probe.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    return "このブラウザではWebGL2を利用できません。";
  }
  return null;
}

export function createImageReader(): ImageReader {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    stencil: false,
  });
  if (!gl) throw new Error("このブラウザではWebGL2を利用できません。");

  const framebuffer = gl.createFramebuffer();
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  return {
    async read(bytes, filename) {
      const blob = new Blob([bytes as BlobPart], { type: mimeTypeFor(filename) });
      const bitmap = await createImageBitmap(blob, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      const { width, height } = bitmap;
      const texture = gl.createTexture();
      try {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error(`${filename} を読み出せませんでした。`);
        }
        const data = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return { width, height, data };
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteTexture(texture);
        bitmap.close();
      }
    },
    dispose() {
      gl.deleteFramebuffer(framebuffer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
