/**
 * Client-safe tenant types and color tables.
 *
 * Kept separate from the server module (`tenants-server.ts`) because that
 * module imports `node:fs`, which the Next.js client bundle cannot resolve.
 * Components that only need types/colors should import from here.
 */

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
  /**
   * Server-only secret. Stored in tenants.json and read by the AI features.
   * Never serialise this to API responses — use PublicTenant for anything that
   * crosses to the browser. See toPublicTenant() in tenants-server.ts.
   */
  geminiApiKey?: string;
  /** Present only on API responses: whether a tenant-level key is set. */
  hasGeminiApiKey?: boolean;
}

/**
 * The shape safe to send to the browser: identical to Tenant but with the
 * secret stripped and replaced by a boolean flag.
 */
export type PublicTenant = Omit<Tenant, "geminiApiKey"> & {
  hasGeminiApiKey: boolean;
};

/**
 * Tint classes per tenant colour. The surfaces are alpha tints of the hue so
 * they sit correctly on both the light and the dark theme; only the text
 * shade needs a dark-mode override.
 */
export const TENANT_COLOR_CLASSES: Record<
  TenantColor,
  { bg: string; text: string; border: string; dot: string }
> = {
  emerald: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-300",
    border: "border-emerald-500/30",
    dot: "bg-emerald-500",
  },
  blue: {
    bg: "bg-blue-500/10",
    text: "text-blue-700 dark:text-blue-300",
    border: "border-blue-500/30",
    dot: "bg-blue-500",
  },
  amber: {
    bg: "bg-amber-500/10",
    text: "text-amber-700 dark:text-amber-300",
    border: "border-amber-500/30",
    dot: "bg-amber-500",
  },
  rose: {
    bg: "bg-rose-500/10",
    text: "text-rose-700 dark:text-rose-300",
    border: "border-rose-500/30",
    dot: "bg-rose-500",
  },
  violet: {
    bg: "bg-violet-500/10",
    text: "text-violet-700 dark:text-violet-300",
    border: "border-violet-500/30",
    dot: "bg-violet-500",
  },
  slate: {
    bg: "bg-slate-500/10",
    text: "text-slate-700 dark:text-slate-300",
    border: "border-slate-500/30",
    dot: "bg-slate-500",
  },
};
