import type { SegmentationResult } from "./types.js";

export function toJSON(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function csvEscape(v: string | number): string {
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 段级 CSV：区间、长度、时间戳、均值、各维 SSE、未惩罚成本。 */
export function segmentsToCSV(result: SegmentationResult): string {
  const d = result.d;
  const header = [
    "segment_index",
    "start_sample_index",
    "end_sample_index",
    "length",
    "start_timestamp",
    "end_timestamp",
    ...Array.from({ length: d }, (_, j) => `mean_dim_${j + 1}`),
    ...Array.from({ length: d }, (_, j) => `raw_sse_dim_${j + 1}`),
    ...Array.from({ length: d }, (_, j) => `weighted_sse_dim_${j + 1}`),
    "unpenalized_cost",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const seg of result.segments) {
    lines.push(
      [
        seg.segmentIndex,
        seg.startSampleIndex,
        seg.endSampleIndex,
        seg.length,
        seg.startTimestamp,
        seg.endTimestamp,
        ...seg.mean,
        ...seg.dimensionCosts.map((c) => c.rawSSE),
        ...seg.dimensionCosts.map((c) => c.weightedSSE),
        seg.unpenalizedCost,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  lines.push(
    [
      "summary",
      "",
      "",
      result.n,
      "",
      "",
      ...Array.from({ length: d }, () => ""),
      ...Array.from({ length: d }, () => ""),
      ...Array.from({ length: d }, () => ""),
      result.totalUnpenalizedCost,
    ]
      .map(csvEscape)
      .join(","),
  );
  return lines.join("\r\n");
}

/** 原始样本 CSV（导入/复核辅助）。 */
export function samplesToCSV(
  timestamps: number[],
  matrix: number[][],
): string {
  const d = matrix[0]?.length ?? 0;
  const lines = [
    ["sample_index", "timestamp", ...Array.from({ length: d }, (_, j) => `dim_${j + 1}`)]
      .map(csvEscape)
      .join(","),
  ];
  timestamps.forEach((ts, i) => {
    lines.push([i + 1, ts, ...matrix[i]!].map(csvEscape).join(","));
  });
  return lines.join("\r\n");
}
