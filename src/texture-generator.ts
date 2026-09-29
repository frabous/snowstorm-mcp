import { chromium } from "playwright";

export const TEXTURE_PRIMITIVES = [
  "soft_lens",
  "anime_cloud",
  "faceted_crystal",
  "bokeh_disc",
  "puff",
  "ember",
  "streak",
  "lightning",
  "beam_core"
] as const;

export type TexturePrimitive = typeof TEXTURE_PRIMITIVES[number];

export interface TextureGenerationOptions {
  primitive: TexturePrimitive;
  width?: number;
  height?: number;
  seed?: number;
  tint?: string;
  intensity?: number;
}

export interface GeneratedTexture {
  primitive: TexturePrimitive;
  /** The generated PNG file bytes. */
  bytes: Buffer;
  width: number;
  height: number;
  /** Fraction of decoded output pixels whose alpha is greater than zero. */
  alphaCoverage: number;
  /** Fraction with alpha-weighted luminance at or above BRIGHT_COVERAGE_THRESHOLD. */
  brightCoverage: number;
  /** True when at least one decoded output pixel is not fully opaque. */
  hasAlpha: boolean;
  seed: number;
}

export const BRIGHT_COVERAGE_THRESHOLD = 0.1;
export const MIN_SOFT_LENS_BRIGHT_COVERAGE = 0.35;
const MAX_TEXTURE_DIMENSION = 8_192;
const MAX_TEXTURE_PIXELS = 16_777_216;
const MAX_FLIPBOOK_CELLS = 65_536;

const DEFAULT_TINTS: Record<TexturePrimitive, string> = {
  soft_lens: "#fff7e8",
  anime_cloud: "#eaf7ff",
  faceted_crystal: "#b8edff",
  bokeh_disc: "#fff1d2",
  puff: "#dce8f4",
  ember: "#ff7625",
  streak: "#fff0bd",
  lightning: "#bdeaff",
  beam_core: "#fff0c9"
};

interface ValidatedTextureOptions {
  primitive: TexturePrimitive;
  width: number;
  height: number;
  seed: number;
  intensity: number;
  color: [number, number, number];
}

function validateDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TEXTURE_DIMENSION) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_TEXTURE_DIMENSION}.`);
  }
}

function validateTextureOptions(options: TextureGenerationOptions): ValidatedTextureOptions {
  if (!options || typeof options !== "object") throw new Error("Texture generation options are required.");
  if (!(TEXTURE_PRIMITIVES as readonly string[]).includes(options.primitive)) {
    throw new Error(`Unsupported texture primitive: ${String(options.primitive)}.`);
  }

  const width = options.width ?? 256;
  const height = options.height ?? 256;
  validateDimension(width, "width");
  validateDimension(height, "height");
  if (width * height > MAX_TEXTURE_PIXELS) {
    throw new Error(`Texture exceeds the ${MAX_TEXTURE_PIXELS.toLocaleString("en-US")} pixel limit.`);
  }

  const seed = options.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("seed must be an unsigned 32-bit integer.");
  }
  const intensity = options.intensity ?? 1;
  if (!Number.isFinite(intensity) || intensity <= 0 || intensity > 1) {
    throw new Error("intensity must be greater than 0 and at most 1.");
  }
  const tint = options.tint ?? DEFAULT_TINTS[options.primitive];
  if (!/^#[\da-f]{6}$/i.test(tint)) throw new Error("tint must be a six-digit hex color such as #aabbcc.");

  return {
    primitive: options.primitive,
    width,
    height,
    seed,
    intensity,
    color: [
      Number.parseInt(tint.slice(1, 3), 16),
      Number.parseInt(tint.slice(3, 5), 16),
      Number.parseInt(tint.slice(5, 7), 16)
    ]
  };
}

/** Generates and measures one transparent PNG using the repository's installed Chromium. */
export async function generateTexture(options: TextureGenerationOptions): Promise<GeneratedTexture> {
  const validated = validateTextureOptions(options);
  const browser = await chromium.launch({ headless: true });
  let dataUrl: string;
  let metrics: { width: number; height: number; alphaCoverage: number; brightCoverage: number; hasAlpha: boolean };
  try {
    const page = await browser.newPage();
    const drawTexture = async (input: typeof validated & { brightThreshold: number }) => {
      const { primitive, width, height, seed, intensity, color, brightThreshold } = input;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Chromium could not create a 2D canvas context.");
      const image = context.createImageData(width, height);
      const pixels = image.data;
      let randomState = seed >>> 0;
      const [random, clamp, smoothstep, hash, noise, paint, pointSegmentDistance] = [
        () => {
          randomState = (randomState + 0x6d2b79f5) >>> 0;
          let value = randomState;
          value = Math.imul(value ^ value >>> 15, value | 1);
          value ^= value + Math.imul(value ^ value >>> 7, value | 61);
          return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
        },
        (value: number) => Math.max(0, Math.min(1, value)),
        (edge0: number, edge1: number, value: number) => {
          const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
          return t * t * (3 - 2 * t);
        },
        (x: number, y: number) => {
          let value = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + (seed | 0)) | 0;
          value = Math.imul(value ^ value >>> 13, 1274126177);
          return ((value ^ value >>> 16) >>> 0) / 4_294_967_295;
        },
        (x: number, y: number) => {
          const ix = Math.floor(x);
          const iy = Math.floor(y);
          const fx = x - ix;
          const fy = y - iy;
          const sx = fx * fx * (3 - 2 * fx);
          const sy = fy * fy * (3 - 2 * fy);
          const top = hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx;
          const bottom = hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx;
          return top * (1 - sy) + bottom * sy;
        },
        (index: number, alpha: number, shade = 1, whiteMix = 0, warmMix = 0) => {
          const a = Math.max(0, Math.min(1, alpha * intensity));
          if (a <= 0) return;
          const warm = [255, 184, 104];
          let red = color[0] * shade;
          let green = color[1] * shade;
          let blue = color[2] * shade;
          red += (255 - red) * Math.max(0, Math.min(1, whiteMix));
          green += (255 - green) * Math.max(0, Math.min(1, whiteMix));
          blue += (255 - blue) * Math.max(0, Math.min(1, whiteMix));
          red += (warm[0]! - red) * Math.max(0, Math.min(1, warmMix));
          green += (warm[1]! - green) * Math.max(0, Math.min(1, warmMix));
          blue += (warm[2]! - blue) * Math.max(0, Math.min(1, warmMix));
          pixels[index] = Math.round(Math.max(0, Math.min(1, red / 255)) * 255);
          pixels[index + 1] = Math.round(Math.max(0, Math.min(1, green / 255)) * 255);
          pixels[index + 2] = Math.round(Math.max(0, Math.min(1, blue / 255)) * 255);
          pixels[index + 3] = Math.round(a * 255);
        },
        (x: number, y: number, a: [number, number], b: [number, number]) => {
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const lengthSquared = dx * dx + dy * dy;
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared));
          return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
        }
      ] as const;
      const phases: number[] = [];
      for (let index = 0; index < 8; index += 1) phases.push(random() * Math.PI * 2);

      let bolt: [number, number][] = [];
      let branch: [number, number][] = [];
      if (primitive === "lightning") {
        let x = (random() - 0.5) * 0.14;
        bolt = [[x, -0.96]];
        for (let step = 1; step <= 8; step += 1) {
          x = Math.max(-0.62, Math.min(0.62, x + (random() - 0.5) * 0.64));
          bolt.push([x, -0.96 + step * 0.24]);
        }
        const branchOrigin = bolt[4]!;
        branch = [branchOrigin, [branchOrigin[0] + 0.24, branchOrigin[1] + 0.13], [branchOrigin[0] + 0.4, branchOrigin[1] + 0.39]];
      }
      const cloudFrequencies = [2.7, 4.3, 6.1, 9.7, 14.3, 21.1];
      const cloudAmplitudes = [0.15, 0.092, 0.061, 0.038, 0.024, 0.014];
      const puffLobes: Array<[number, number, number, number]> = [
        [-0.43, 0.02, 0.31, 0.4], [-0.25, -0.28, 0.31, 0.35], [0.08, -0.35, 0.32, 0.39],
        [0.38, -0.17, 0.31, 0.38], [0.48, 0.14, 0.27, 0.33], [0.15, 0.25, 0.39, 0.35],
        [-0.23, 0.27, 0.38, 0.33], [0, 0.43, 0.48, 0.28]
      ];
      const lightningSegments = [bolt, branch];

      for (let py = 0; py < height; py += 1) {
        const y = ((py + 0.5) / height) * 2 - 1;
        for (let px = 0; px < width; px += 1) {
          const x = ((px + 0.5) / width) * 2 - 1;
          const index = (py * width + px) * 4;
          const radius = Math.hypot(x, y);

          if (primitive === "soft_lens") {
            // Broad measured profile: intentionally no narrow bright core.
            const d = Math.sqrt((x / 0.92) ** 2 + (y / 0.8) ** 2);
            paint(index, d < 1 ? (1 - d) ** 0.85 : 0);
          } else if (primitive === "anime_cloud") {
            const angle = Math.atan2(y, x);
            let lobes = 0;
            for (let index = 0; index < cloudFrequencies.length; index += 1) {
              const modulation = 0.62 + 0.76 * noise(x * (index + 3) + 13.1, y * (index + 3) - 8.7);
              lobes += cloudAmplitudes[index]! * modulation * Math.cos(cloudFrequencies[index]! * angle + phases[index]!);
            }
            const boundary = 0.67 * (1 + lobes + 0.035 * (noise(x * 7.3, y * 7.3) - 0.5));
            const edgeBand = smoothstep(boundary - 0.24, boundary, radius);
            const erosion = noise(x * 38.7 + 4.4, y * 38.7 - 2.8) * 0.13 * edgeBand;
            const edgeDistance = boundary - radius - erosion;
            let alpha = smoothstep(-0.055, 0.11, edgeDistance);
            if (radius < 0.2) alpha = Math.max(alpha, 0.96);
            const rim = Math.exp(-(((edgeDistance - 0.025) / 0.055) ** 2)) * edgeBand;
            paint(index, alpha, 0.88 + 0.12 * noise(x * 5.4, y * 5.4), 0.08 + rim * 0.34);
          } else if (primitive === "faceted_crystal") {
            const diamond = Math.abs(x) / 0.48 + Math.abs(y) / 0.92;
            const alpha = smoothstep(1.09, 0.9, diamond);
            const facet = Math.floor((Math.atan2(y, x) + Math.PI) / (Math.PI / 3)) % 6;
            const shades = [0.68, 0.91, 0.77, 1, 0.72, 0.86];
            const edgeLine = Math.exp(-(((x + 0.2 * y + 0.3) / 0.035) ** 2));
            const warmFace = Math.exp(-(((x - 0.02 * y) / 0.15) ** 2)) * smoothstep(-0.82, 0.08, y);
            paint(index, alpha, shades[facet]!, 0.16 + edgeLine * 0.7, warmFace * 0.72);
          } else if (primitive === "bokeh_disc") {
            const angle = Math.atan2(y, x);
            const boundary = 0.94 * (1 - 0.018 * Math.cos(6 * angle));
            const d = radius / boundary;
            const edge = 1 - smoothstep(0.88, 1.02, d);
            const ring = Math.exp(-(((d - 0.67) / 0.14) ** 2));
            const center = Math.exp(-((d / 0.42) ** 2));
            paint(index, edge * (0.27 + 0.54 * ring + 0.2 * center), 0.9 + 0.1 * ring, 0.1 + 0.18 * ring);
          } else if (primitive === "puff") {
            let alpha = 0;
            let highlight = 0;
            for (const [cx, cy, rx, ry] of puffLobes) {
              const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
              alpha = Math.max(alpha, smoothstep(1.13, 0.82, d));
              highlight = Math.max(highlight, Math.exp(-(((d - 0.83) / 0.19) ** 2)));
            }
            paint(index, alpha, 0.76 + 0.18 * (1 - Math.abs(y)), 0.12 + highlight * 0.13);
          } else if (primitive === "ember") {
            const t = (y + 0.91) / 1.82;
            const safeT = clamp(t);
            const centerX = 0.13 * Math.sin((safeT - 0.18) * Math.PI) + (noise(px * 0.08, py * 0.11) - 0.5) * 0.035;
            const widthAtY = 0.045 + 0.5 * Math.sin(Math.PI * safeT) ** 0.82 * (0.86 + noise(px * 0.06 + 7, py * 0.09) * 0.14);
            const across = Math.abs(x - centerX) / widthAtY;
            const vertical = 1 - smoothstep(0.985, 1.04, Math.abs(t - 0.5) * 2);
            const alpha = smoothstep(1.12, 0.74, across) * vertical;
            const core = 1 - smoothstep(0.08, 0.72, across);
            paint(index, alpha, 0.9, core * 0.48, core * 0.28);
          } else if (primitive === "streak") {
            const cosine = Math.cos(0.34);
            const sine = Math.sin(0.34);
            const along = x * cosine + y * sine;
            const across = -x * sine + y * cosine;
            const widthAtX = 0.055 + 0.12 * smoothstep(-0.88, 0.7, along);
            const ends = smoothstep(-1.04, -0.78, along) * (1 - smoothstep(0.72, 0.98, along));
            const ribbon = (1 - smoothstep(widthAtX * 0.7, widthAtX * 1.25, Math.abs(across))) * ends;
            const head = Math.exp(-(((along - 0.58) / 0.18) ** 2 + (across / 0.13) ** 2));
            paint(index, Math.max(ribbon * 0.78, head * 0.94), 0.88, 0.15 + head * 0.48);
          } else if (primitive === "lightning") {
            let coreDistance = Number.POSITIVE_INFINITY;
            let haloDistance = Number.POSITIVE_INFINITY;
            for (const points of lightningSegments) {
              for (let segment = 0; segment < points.length - 1; segment += 1) {
                const distance = pointSegmentDistance(x, y, points[segment]!, points[segment + 1]!);
                coreDistance = Math.min(coreDistance, distance);
                haloDistance = Math.min(haloDistance, distance);
              }
            }
            const core = Math.exp(-((coreDistance / 0.035) ** 2));
            const halo = Math.exp(-((haloDistance / 0.19) ** 2)) * 0.44;
            paint(index, Math.min(1, core * 0.92 + halo), 0.76 + core * 0.24, core * 0.74);
          } else if (primitive === "beam_core") {
            const cosine = Math.cos(-0.08);
            const sine = Math.sin(-0.08);
            const along = x * cosine + y * sine;
            const across = -x * sine + y * cosine;
            const end = 1 - smoothstep(0.78, 1.03, Math.abs(along));
            const plume = Math.exp(-((across / 0.58) ** 2)) * 0.22;
            const body = Math.exp(-((across / 0.34) ** 2)) * 0.56;
            const broadCore = Math.exp(-((across / 0.19) ** 2)) * 0.8;
            const hotCore = Math.exp(-((across / 0.105) ** 2));
            paint(index, end * Math.min(1, plume + body + broadCore), 0.9, 0.12 + hotCore * 0.55);
          }
        }
      }

      context.putImageData(image, 0, 0);
      const png = canvas.toDataURL("image/png");
      const decodedImage = new Image();
      decodedImage.src = png;
      await decodedImage.decode();
      const decodedCanvas = document.createElement("canvas");
      decodedCanvas.width = decodedImage.naturalWidth;
      decodedCanvas.height = decodedImage.naturalHeight;
      const decodedContext = decodedCanvas.getContext("2d", { willReadFrequently: true });
      if (!decodedContext) throw new Error("Chromium could not measure the encoded PNG.");
      decodedContext.drawImage(decodedImage, 0, 0);
      const decoded = decodedContext.getImageData(0, 0, decodedCanvas.width, decodedCanvas.height).data;
      let alphaPixels = 0;
      let brightPixels = 0;
      let hasAlpha = false;
      const pixelCount = decodedCanvas.width * decodedCanvas.height;
      for (let index = 0; index < decoded.length; index += 4) {
        const alpha = decoded[index + 3]! / 255;
        if (alpha > 0) alphaPixels += 1;
        if (alpha < 1) hasAlpha = true;
        const luminance = (0.2126 * decoded[index]! + 0.7152 * decoded[index + 1]! + 0.0722 * decoded[index + 2]!) / 255;
        if (alpha * luminance >= brightThreshold) brightPixels += 1;
      }
      return {
        dataUrl: png,
        width: decodedCanvas.width,
        height: decodedCanvas.height,
        alphaCoverage: alphaPixels / pixelCount,
        brightCoverage: brightPixels / pixelCount,
        hasAlpha
      };
    };
    const output = await page.evaluate(drawTexture, { ...validated, brightThreshold: BRIGHT_COVERAGE_THRESHOLD });
    dataUrl = output.dataUrl;
    metrics = {
      width: output.width,
      height: output.height,
      alphaCoverage: output.alphaCoverage,
      brightCoverage: output.brightCoverage,
      hasAlpha: output.hasAlpha
    };
  } finally {
    await browser.close();
  }

  if (validated.primitive === "soft_lens" && metrics.brightCoverage < MIN_SOFT_LENS_BRIGHT_COVERAGE) {
    throw new Error(
      `soft_lens bright coverage must be at least ${MIN_SOFT_LENS_BRIGHT_COVERAGE * 100}% of the full frame; measured ${(metrics.brightCoverage * 100).toFixed(2)}%.`
    );
  }

  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return { primitive: validated.primitive, bytes, ...metrics, seed: validated.seed };
}

export interface FlipbookAtlasOptions {
  columns: number;
  rows: number;
  direction?: "horizontal" | "vertical";
  startColumn?: number;
  startRow?: number;
  frameCount?: number;
  framesPerSecond?: number;
  stretchToLifetime?: boolean;
}

export interface FlipbookFrameUv {
  index: number;
  column: number;
  row: number;
  uv: [number, number];
  uvSize: [number, number];
}

export interface FlipbookValues {
  base_UV: [number, number];
  size_UV: [number, number];
  step_UV: [number, number];
  frames_per_second: number;
  max_frame: number;
  stretch_to_lifetime: boolean;
}

export interface FlipbookAtlas {
  imageWidth: number;
  imageHeight: number;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  frames: FlipbookFrameUv[];
  uv: {
    texture_width: number;
    texture_height: number;
    uv: [number, number];
    uv_size: [number, number];
    flipbook: FlipbookValues;
  };
}

/**
 * Calculates Bedrock UV/flipbook fields from the caller's actual image dimensions.
 * The animated run stays within one grid row or column because step_UV is linear.
 */
export function createFlipbookAtlas(imageWidth: number, imageHeight: number, options: FlipbookAtlasOptions): FlipbookAtlas {
  validateDimension(imageWidth, "imageWidth");
  validateDimension(imageHeight, "imageHeight");
  if (imageWidth * imageHeight > MAX_TEXTURE_PIXELS) {
    throw new Error(`Atlas exceeds the ${MAX_TEXTURE_PIXELS.toLocaleString("en-US")} pixel limit.`);
  }
  if (!options || typeof options !== "object") throw new Error("Flipbook grid options are required.");
  const { columns, rows } = options;
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new Error("columns and rows must be positive integers.");
  }
  if (columns * rows > MAX_FLIPBOOK_CELLS) {
    throw new Error(`Flipbook grid exceeds the ${MAX_FLIPBOOK_CELLS.toLocaleString("en-US")} frame limit.`);
  }
  if (imageWidth % columns !== 0 || imageHeight % rows !== 0) {
    throw new Error(`Atlas dimensions ${imageWidth}x${imageHeight} must divide evenly into a ${columns}x${rows} grid.`);
  }
  const direction = options.direction ?? "vertical";
  if (direction !== "horizontal" && direction !== "vertical") throw new Error("direction must be horizontal or vertical.");
  const startColumn = options.startColumn ?? 0;
  const startRow = options.startRow ?? 0;
  if (!Number.isInteger(startColumn) || startColumn < 0 || startColumn >= columns) {
    throw new Error(`startColumn must be an integer from 0 to ${columns - 1}.`);
  }
  if (!Number.isInteger(startRow) || startRow < 0 || startRow >= rows) {
    throw new Error(`startRow must be an integer from 0 to ${rows - 1}.`);
  }
  const availableFrames = direction === "horizontal" ? columns - startColumn : rows - startRow;
  const frameCount = options.frameCount ?? availableFrames;
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > availableFrames) {
    throw new Error(`frameCount must be an integer from 1 to ${availableFrames} for the selected ${direction} run.`);
  }
  const framesPerSecond = options.framesPerSecond ?? 10;
  if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
    throw new Error("framesPerSecond must be a positive finite number.");
  }
  const stretchToLifetime = options.stretchToLifetime ?? true;
  if (typeof stretchToLifetime !== "boolean") throw new Error("stretchToLifetime must be a boolean.");

  const frameWidth = imageWidth / columns;
  const frameHeight = imageHeight / rows;
  const baseUv: [number, number] = [startColumn * frameWidth, startRow * frameHeight];
  const frameSize: [number, number] = [frameWidth, frameHeight];
  const stepUv: [number, number] = direction === "horizontal" ? [frameWidth, 0] : [0, frameHeight];
  const frames: FlipbookFrameUv[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      frames.push({
        index: row * columns + column,
        column,
        row,
        uv: [column * frameWidth, row * frameHeight],
        uvSize: frameSize
      });
    }
  }

  return {
    imageWidth,
    imageHeight,
    columns,
    rows,
    frameWidth,
    frameHeight,
    frames,
    uv: {
      texture_width: imageWidth,
      texture_height: imageHeight,
      uv: baseUv,
      uv_size: frameSize,
      flipbook: {
        base_UV: baseUv,
        size_UV: frameSize,
        step_UV: stepUv,
        frames_per_second: framesPerSecond,
        max_frame: frameCount,
        stretch_to_lifetime: stretchToLifetime
      }
    }
  };
}

/** Snake-case alias matching the plan's `flipbook_atlas` helper name. */
export const flipbook_atlas = createFlipbookAtlas;
