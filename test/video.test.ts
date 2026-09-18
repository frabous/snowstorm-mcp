import path from "node:path";
import { describe, expect, it } from "vitest";
import { audioCoverage, comparisonFilter, enforceComparisonBudget, previewReportPath, rankAudioTransients } from "../src/video.js";

describe("reference video helpers", () => {
  it("builds an aspect-preserving side-by-side filter", () => {
    const filter = comparisonFilter(640, 360);
    expect(filter).toContain("scale=640:360:force_original_aspect_ratio=decrease");
    expect(filter).toContain("pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black");
    expect(filter).toContain("[left][right]hstack=inputs=2[v]");
  });

  it("ranks attacks by strength and keeps the requested minimum spacing", () => {
    expect(rankAudioTransients([0.9, 0.8, 0, 0.7], {
      startSeconds: 10,
      hopSamples: 1,
      frameSize: 0,
      sampleRate: 1,
      maxResults: 3,
      minimumSpacingSeconds: 2
    })).toEqual([
      { seconds: 10, strength: 0.9 },
      { seconds: 13, strength: 0.7 }
    ]);
  });

  it("recognizes only registered scene and particle preview layouts", () => {
    expect(previewReportPath(path.join("C:", "artifacts", "scenes", "run", "scene.mp4"))).toBe(path.join("C:", "artifacts", "scenes", "run", "report.json"));
    expect(previewReportPath(path.join("C:", "artifacts", "renders", "run", "preview.mp4"))).toBe(path.join("C:", "artifacts", "renders", "run", "report.json"));
    expect(previewReportPath(path.join("C:", "artifacts", "reference-videos", "source.mp4"))).toBeNull();
  });

  it("uses bounded stream duration when present and container duration otherwise", () => {
    expect(audioCoverage({ start_time: "0.25", duration: "2.5" }, 10)).toEqual({ startSeconds: 0.25, durationSeconds: 2.5 });
    expect(audioCoverage({ start_time: "0" }, 10)).toEqual({ startSeconds: 0, durationSeconds: 10 });
    expect(audioCoverage(undefined, Number.NaN)).toBeNull();
  });

  it("bounds comparison raster work", () => {
    expect(() => enforceComparisonBudget(4.5, 640, 360)).not.toThrow();
    expect(() => enforceComparisonBudget(30, 1920, 1080)).toThrow("rendered-pixel budget");
  });
});
