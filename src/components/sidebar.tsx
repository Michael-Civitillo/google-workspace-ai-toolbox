"use client";

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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TenantSwitcher } from "./tenant-switcher";
import { LogoutButton } from "./logout-button";

const navigation = [
  {
    label: null,
    items: [
      { name: "Dashboard", href: "/", icon: LayoutDashboard },
      { name: "Get Started", href: "/onboarding", icon: Sparkles },
    ],
  },
  {
    label: "Delegation",
    items: [
      { name: "Email Delegation", href: "/email-delegation", icon: Mail },
      {
        name: "Calendar Delegation",
        href: "/calendar-delegation",
        icon: CalendarDays,
      },
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
    ],
  },
  {
    label: "Workspace",
    items: [
      { name: "Setup", href: "/setup", icon: Settings },
      { name: "Tenants", href: "/tenants", icon: Building2 },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  if (pathname === "/login") return null;

  return (
    <aside className="fixed inset-y-0 left-0 w-64 bg-card border-r border-border flex flex-col z-50">
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <Image
            src="/logo.svg"
            alt="GWS AI Toolbox"
            width={36}
            height={36}
            className="rounded-lg"
          />
          <div>
            <h1 className="text-sm font-semibold tracking-tight">
              AI Toolbox
            </h1>
            <p className="text-xs text-muted-foreground">Google Workspace</p>
          </div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-border">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 px-1">
          Tenant
        </p>
        <TenantSwitcher />
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto p-3">
        {navigation.map((group) => (
          <div key={group.label ?? "main"} className="mb-1">
            {group.label && (
              <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <item.icon
                      className={cn("h-4 w-4", isActive && "text-primary dark:text-primary-foreground")}
                    />
                    {item.name}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-border">
        <LogoutButton />
      </div>
    </aside>
  );
}
