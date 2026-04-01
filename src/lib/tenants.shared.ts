export const TENANT_COLORS = [
  "emerald",
  "blue",
  "amber",
  "rose",
  "violet",
  "slate",
] as const;

export type TenantColor = (typeof TENANT_COLORS)[number];

export interface Tenant {
  id: string;
  name: string;
  color: TenantColor;
  credentialsFile: string;
  adminEmail: string;
  geminiApiKey?: string;
}

/** Color classes used to visually distinguish tenants */
export const TENANT_COLOR_CLASSES: Record<
  TenantColor,
  { bg: string; text: string; border: string; dot: string }
> = {
  emerald: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    dot: "bg-emerald-500",
  },
  blue: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    dot: "bg-blue-500",
  },
  amber: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    dot: "bg-amber-500",
  },
  rose: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    border: "border-rose-200",
    dot: "bg-rose-500",
  },
  violet: {
    bg: "bg-violet-50",
    text: "text-violet-700",
    border: "border-violet-200",
    dot: "bg-violet-500",
  },
  slate: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    border: "border-slate-300",
    dot: "bg-slate-500",
  },
};
