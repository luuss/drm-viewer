// Poisons canvas extraction methods for any canvas inside #tile-grid.
// Must run once at app init.
let installed = false;

export function installCanvasPoison() {
  if (installed) return;
  installed = true;

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  (HTMLCanvasElement.prototype as any).toDataURL = function (...args: any[]) {
    if (this.closest("#tile-grid") || this.id === "noise-overlay") {
      return "data:image/png;base64,";
    }
    return origToDataURL.apply(this, args as any);
  };
  (HTMLCanvasElement.prototype as any).toBlob = function (cb: any, ...rest: any[]) {
    if (this.closest("#tile-grid") || this.id === "noise-overlay") {
      cb?.(null);
      return;
    }
    return origToBlob.apply(this, [cb, ...rest] as any);
  };
  (CanvasRenderingContext2D.prototype as any).getImageData = function (...args: any[]) {
    if (this.canvas.closest("#tile-grid")) return new ImageData(1, 1);
    return origGetImageData.apply(this, args as any);
  };
  const origReadPixels = WebGLRenderingContext.prototype.readPixels;
  (WebGLRenderingContext.prototype as any).readPixels = function (...args: any[]) {
    if ((this as any).canvas?.closest?.("#tile-grid")) return;
    return origReadPixels.apply(this, args as any);
  };
  if (window.WebGL2RenderingContext) {
    const origRP2 = WebGL2RenderingContext.prototype.readPixels;
    (WebGL2RenderingContext.prototype as any).readPixels = function (...args: any[]) {
      if ((this as any).canvas?.closest?.("#tile-grid")) return;
      return origRP2.apply(this, args as any);
    };
  }

  // Keep raw access internally
  (window as any).__origGetImageData = origGetImageData;
}

export function getRawImageData(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  const raw = (window as any).__origGetImageData as typeof CanvasRenderingContext2D.prototype.getImageData;
  return raw.call(ctx, 0, 0, w, h);
}
