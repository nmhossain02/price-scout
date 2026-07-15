import type { Observation } from "../types";
import { formatMoney } from "../lib/format";

export function PriceChart({ observations, height = 180 }: { observations: Observation[]; height?: number }) {
  const points = observations
    .filter((item): item is Observation & { priceMinor: number } => item.priceMinor !== undefined)
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())
    .slice(-30);

  if (points.length < 2) {
    return (
      <div className="chart-placeholder" style={{ height }}>
        <span className="mini-bars"><i /><i /><i /><i /><i /></span>
        <p>Price history appears after two verified checks.</p>
      </div>
    );
  }

  const width = 720;
  const paddingX = 12;
  const paddingY = 16;
  const values = points.map((item) => item.priceMinor);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = Math.max(rawMax - rawMin, Math.max(rawMax * 0.02, 100));
  const min = rawMin - spread * 0.15;
  const max = rawMax + spread * 0.15;
  const coords = points.map((point, index) => ({
    x: paddingX + (index / (points.length - 1)) * (width - paddingX * 2),
    y: paddingY + ((max - point.priceMinor) / (max - min)) * (height - paddingY * 2),
    point,
  }));
  const line = coords.map(({ x, y }) => `${x},${y}`).join(" ");
  const area = `${paddingX},${height} ${line} ${width - paddingX},${height}`;
  const currency = points.at(-1)?.currency ?? "USD";

  return (
    <div className="price-chart">
      <div className="chart-range"><span>{formatMoney(rawMax, currency)}</span><span>{formatMoney(rawMin, currency)}</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Price history chart">
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#60f0a7" stopOpacity=".28" />
            <stop offset="1" stopColor="#60f0a7" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={height * 0.25} x2={width} y2={height * 0.25} className="chart-grid" />
        <line x1="0" y1={height * 0.5} x2={width} y2={height * 0.5} className="chart-grid" />
        <line x1="0" y1={height * 0.75} x2={width} y2={height * 0.75} className="chart-grid" />
        <polygon points={area} fill="url(#chart-fill)" />
        <polyline points={line} className="chart-line" />
        {coords.map(({ x, y, point }) => (
          <circle key={point.id} cx={x} cy={y} r="4" className="chart-point">
            <title>{formatMoney(point.priceMinor, point.currency)} · {new Date(point.observedAt).toLocaleString()}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
