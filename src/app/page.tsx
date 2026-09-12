"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { AICommandPanel } from "@/components/ai-command-panel";
import { cn } from "@/lib/utils";
import {
  Mail,
  CalendarDays,
  ArrowRightLeft,
  Globe,
  Shield,
  Loader2,
  UserMinus,
  Share2,
  Sparkles,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  FolderTree,
  Download,
  Upload,
  Users,
  Layers,
  Activity,
  ScrollText,
} from "lucide-react";

interface GwsStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  /** True in the packaged desktop build, where the gws CLI is optional. */
  packaged?: boolean;
}

interface TenantsListPayload {
  tenants?: { id: string }[];
}

interface Task {
  title: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface TaskGroup {
  label: string;
  tasks: Task[];
}

const taskGroups: TaskGroup[] = [
  {
    label: "Access",
    tasks: [
      {
        title: "Email Delegation",
        description: "Grant mailbox access to another user without sharing passwords.",
        href: "/email-delegation",
        icon: Mail,
      },
      {
        title: "Calendar Delegation",
        description: "Share calendar access with configurable permission levels.",
        href: "/calendar-delegation",
        icon: CalendarDays,
      },
      {
        title: "Groups",
        description: "Browse groups, manage members, and see every group a user belongs to.",
        href: "/groups",
        icon: Users,
      },
    ],
  },
  {
    label: "Transfers",
    tasks: [
      {
        title: "Email Transfer",
        description: "Forward incoming mail from one mailbox to another.",
        href: "/email-transfer",
        icon: ArrowRightLeft,
      },
      {
        title: "Calendar Transfer",
        description: "Hand calendar ownership from one user to another.",
        href: "/calendar-transfer",
        icon: ArrowRightLeft,
      },
      {
        title: "Drive Transfer",
        description: "Move ownership of chosen Drive folders and everything inside them.",
        href: "/drive-transfer",
        icon: FolderTree,
      },
    ],
  },
  {
    label: "Lifecycle",
    tasks: [
      {
        title: "Domain Change",
        description: "Switch a user's primary email to another domain in your tenant.",
        href: "/domain-change",
        icon: Globe,
      },
      {
        title: "Offboarding",
        description: "Vacation responder, forwarding, transfers and suspension in one run.",
        href: "/offboarding",
        icon: UserMinus,
      },
      {
        title: "Bulk Operations",
        description: "Run one operation across many users from a CSV, with per-row validation.",
        href: "/bulk",
        icon: Layers,
      },
    ],
  },
  {
    label: "Backup & audits",
    tasks: [
      {
        title: "Mailbox Export",
        description: "Back up an entire Gmail mailbox to a portable file.",
        href: "/mailbox-export",
        icon: Download,
      },
      {
        title: "Mailbox Import",
        description: "Restore a mailbox export into another user, labels and dates intact.",
        href: "/mailbox-import",
        icon: Upload,
      },
      {
        title: "Sharing Audit",
        description: "Find Drive files shared outside your tenant and revoke in one click.",
        href: "/sharing-audit",
        icon: Share2,
      },
      {
        title: "User Audit",
        description: "A full AI access report for any user: mail, calendar, forwarding.",
        href: "/audit",
        icon: Shield,
      },
      {
        title: "Activity Reports",
        description: "Login and admin activity across the tenant, with an AI security digest.",
        href: "/activity-reports",
        icon: Activity,
      },
      {
        title: "Audit Log",
        description: "Every change made through Open Admin, newest first, secrets redacted.",
        href: "/audit-log",
        icon: ScrollText,
      },
    ],
  },
];

function CliStatusPill({
  status,
  loading,
  cliOptional,
}: {
  status: GwsStatus | null;
  loading: boolean;
  cliOptional: boolean;
}) {
  if (loading) {
    return (
      <span className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Checking CLI…
      </span>
    );
  }

  const installed = !!status?.installed;
  const authenticated = !!status?.authenticated;
  const ok = installed && authenticated;
  const tone: "ok" | "muted" | "bad" = ok
    ? "ok"
    : cliOptional
      ? "muted"
      : "bad";
  const label = installed
    ? `gws ${status?.version ?? ""}`.trim() +
      (authenticated ? " · authenticated" : " · not authenticated")
    : cliOptional
      ? "CLI optional in this build"
      : "gws not installed";

  return (
    <Link
      href="/setup"
      title="Open Setup"
      className="group inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card pr-2.5 pl-3 text-xs font-medium text-foreground/80 shadow-xs transition-colors hover:border-foreground/20 hover:text-foreground"
    >
      <span className="relative flex size-2">
        {tone === "ok" && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60 motion-reduce:hidden" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            tone === "ok" && "bg-success",
            tone === "muted" && "bg-muted-foreground/50",
            tone === "bad" && "bg-danger"
          )}
        />
      </span>
      <span className="font-mono text-[11.5px]">{label}</span>
      <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export default function Dashboard() {
  const [status, setStatus] = useState<GwsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [tenantCount, setTenantCount] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/gws/status")
        .then((res) => res.json())
        .catch(() => ({ installed: false, authenticated: false } as GwsStatus)),
      fetch("/api/tenants")
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<TenantsListPayload>;
        })
        .then((d) => (Array.isArray(d?.tenants) ? d.tenants.length : null))
        // null = "couldn't determine", which must NOT trigger the first-run
        // banner — telling an established operator to start onboarding
        // because one fetch failed is worse than showing no banner.
        .catch(() => null),
    ])
      .then(([s, count]) => {
        setStatus(s);
        setTenantCount(count);
      })
      .finally(() => setLoading(false));
  }, []);

  const showFirstRunBanner = !loading && tenantCount === 0;
  // The packaged desktop build talks to Google through the googleapis SDK and
  // never needs the gws CLI, so report its absence as a neutral fact.
  const cliOptional = !!status?.packaged;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Manage your Google Workspace from a single place."
        actions={
          <CliStatusPill
            status={status}
            loading={loading}
            cliOptional={cliOptional}
          />
        }
      />

      {/* First-run onboarding banner */}
      {showFirstRunBanner && (
        <Link
          href="/onboarding"
          className="rgb-ring rgb-ring-hover group mb-8 flex items-center gap-4 rounded-xl border border-primary/25 bg-primary/5 p-4 outline-none transition-colors hover:bg-primary/8 focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold tracking-tight">
              Let&apos;s get you set up
            </span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
              No tenants configured yet. Walk through the guided setup: install
              the CLI, add a service account and connect your first Google
              Workspace tenant.
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
            Start
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      )}

      {/* AI Command */}
      <section className="mb-10">
        <AICommandPanel />
      </section>

      {/* Admin tasks */}
      <div className="space-y-8">
        {taskGroups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {group.label}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.tasks.map((task) => (
                <Link
                  key={task.href}
                  href={task.href}
                  className="rgb-ring rgb-ring-hover group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/40"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground/70 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                      <task.icon className="size-[18px]" />
                    </span>
                    <ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold tracking-tight">
                      {task.title}
                    </p>
                    <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                      {task.description}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
