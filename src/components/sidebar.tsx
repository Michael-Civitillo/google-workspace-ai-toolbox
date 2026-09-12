"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Image from "next/image";
import {
  LayoutDashboard,
  Mail,
  CalendarDays,
  ArrowRightLeft,
  Globe,
  Shield,
  Settings,
  Building2,
  UserMinus,
  Share2,
  Sparkles,
  FolderTree,
  Download,
  Upload,
  ScrollText,
  Users,
  Activity,
  Layers,
  KeyRound,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TenantSwitcher } from "./tenant-switcher";
import { SidebarFooter } from "./sidebar-footer";

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const navigation: NavGroup[] = [
  {
    label: null,
    items: [
      { name: "Dashboard", href: "/", icon: LayoutDashboard },
      { name: "Get Started", href: "/onboarding", icon: Sparkles },
    ],
  },
  {
    label: "Access",
    items: [
      { name: "Email Delegation", href: "/email-delegation", icon: Mail },
      {
        name: "Calendar Delegation",
        href: "/calendar-delegation",
        icon: CalendarDays,
      },
      { name: "Groups", href: "/groups", icon: Users },
    ],
  },
  {
    label: "Transfers",
    items: [
      { name: "Email Transfer", href: "/email-transfer", icon: ArrowRightLeft },
      {
        name: "Calendar Transfer",
        href: "/calendar-transfer",
        icon: ArrowRightLeft,
      },
      { name: "Drive Transfer", href: "/drive-transfer", icon: FolderTree },
    ],
  },
  {
    label: "Lifecycle",
    items: [
      { name: "Domain Change", href: "/domain-change", icon: Globe },
      { name: "Offboarding", href: "/offboarding", icon: UserMinus },
      { name: "Bulk Operations", href: "/bulk", icon: Layers },
    ],
  },
  {
    label: "Backup",
    items: [
      { name: "Mailbox Export", href: "/mailbox-export", icon: Download },
      { name: "Mailbox Import", href: "/mailbox-import", icon: Upload },
    ],
  },
  {
    label: "Audits",
    items: [
      { name: "Sharing Audit", href: "/sharing-audit", icon: Share2 },
      { name: "User Audit", href: "/audit", icon: Shield },
      { name: "Activity Reports", href: "/activity-reports", icon: Activity },
      { name: "Audit Log", href: "/audit-log", icon: ScrollText },
    ],
  },
  {
    label: "Settings",
    items: [
      { name: "Setup", href: "/setup", icon: Settings },
      { name: "Tenants", href: "/tenants", icon: Building2 },
      { name: "Single Sign-On", href: "/sso", icon: KeyRound },
      { name: "App Settings", href: "/settings", icon: Settings2 },
    ],
  },
];

const logoGlow = {
  "--rgb-glow-spread": "2px",
  "--rgb-glow-blur": "9px",
  "--rgb-speed": "10s",
} as CSSProperties;

export function Sidebar() {
  const pathname = usePathname();

  if (pathname === "/login") return null;

  return (
    <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <Link
        href="/"
        className="flex items-center gap-3 px-5 pt-5 pb-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <span className="rgb-glow shrink-0 rounded-[10px]" style={logoGlow}>
          <Image
            src="/logo.svg"
            alt=""
            width={32}
            height={32}
            className="relative block rounded-[10px]"
            priority
          />
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[13px] font-semibold tracking-tight">
            Open Admin
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            Google Workspace
          </span>
        </span>
      </Link>

      <div className="px-3 pb-3">
        <TenantSwitcher />
      </div>

      <nav
        aria-label="Primary"
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3"
      >
        {navigation.map((group) => (
          <div key={group.label ?? "main"} className="mb-4 last:mb-0">
            {group.label && (
              <p className="px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                {group.label}
              </p>
            )}
            <ul className="space-y-px">
              {group.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href + "/"));
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "group/nav relative flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-[13px] font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/40",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                      )}
                    >
                      {isActive && (
                        <span
                          aria-hidden
                          className="rgb-bar absolute top-1/2 -left-3 h-5 w-[3px] -translate-y-1/2 rounded-r-full"
                        />
                      )}
                      <item.icon
                        className={cn(
                          "size-4 shrink-0 transition-colors",
                          isActive
                            ? "text-primary"
                            : "text-muted-foreground/80 group-hover/nav:text-foreground"
                        )}
                        strokeWidth={isActive ? 2.25 : 2}
                      />
                      <span className="truncate">{item.name}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <SidebarFooter />
    </aside>
  );
}
