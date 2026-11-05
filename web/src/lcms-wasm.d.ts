declare module "lcms-wasm" {
  export interface Lcms {
    cmsOpenProfileFromMem(data: Uint8Array, size: number): number;
    cmsCreate_sRGBProfile(): number;
    cmsGetColorSpaceASCII(profile: number): string;
    cmsCloseProfile(profile: number): void;
    cmsCreateTransform(
      input: number,
      inputFormat: number,
      output: number,
      outputFormat: number,
      intent: number,
      flags: number,
    ): number;
    cmsDoTransform(transform: number, input: ArrayLike<number>, size: number): ArrayLike<number>;
    cmsDeleteTransform(transform: number): void;
  }
  export function instantiate(opts?: { locateFile?: (name: string) => string }): Promise<Lcms>;
  export default instantiate;
  export const TYPE_CMYK_8: number;
  export const TYPE_RGB_8: number;
  export const INTENT_RELATIVE_COLORIMETRIC: number;
  export const cmsFLAGS_BLACKPOINTCOMPENSATION: number;
}
