export function formatUsd(n: number, digits = 2): string {
  const body = new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
  return `${body} $`;
}

export function formatPlain(n: number, digits = 1): string {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function formatProb(p: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(p);
}

export function formatCents(price: number): string {
  return `${formatPlain(price * 100, 1)} c`;
}

export function formatSignedUsd(n: number): string {
  const body = formatUsd(Math.abs(n), 2);
  if (n > 0) return `+${body}`;
  if (n < 0) return `−${body}`;
  return formatUsd(0, 2);
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}
