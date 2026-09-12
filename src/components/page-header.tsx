import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description: string;
  /** Short context label rendered as an eyebrow above the title, e.g. "Gmail". */
  badge?: string;
  /** Controls aligned to the right of the title (status pills, primary actions). */
  actions?: ReactNode;
}

export function PageHeader({ title, description, badge, actions }: PageHeaderProps) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 max-w-3xl">
        {badge && (
          <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            <span aria-hidden className="size-1.5 rounded-full bg-primary" />
            {badge}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground text-pretty">
          {description}
        </p>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
