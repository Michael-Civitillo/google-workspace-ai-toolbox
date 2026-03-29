"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Mail,
  CalendarDays,
  ArrowRightLeft,
  Settings,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  {
    name: "Dashboard",
    href: "/",
    icon: LayoutDashboard,
  },
  {
    name: "Email Delegation",
    href: "/email-delegation",
    icon: Mail,
  },
  {
    name: "Calendar Delegation",
    href: "/calendar-delegation",
    icon: CalendarDays,
  },
  {
    name: "Calendar Transfer",
    href: "/calendar-transfer",
    icon: ArrowRightLeft,
  },
  {
    name: "Email Transfer",
    href: "/email-transfer",
    icon: ArrowRightLeft,
  },
  {
    name: "Setup",
    href: "/setup",
    icon: Settings,
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 w-64 bg-card border-r border-border flex flex-col z-50">
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
            <Shield className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">
              Workspace Admin
            </h1>
            <p className="text-xs text-muted-foreground">Google Workspace</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border">
        <p className="text-xs text-muted-foreground">
          Powered by{" "}
          <a
            href="https://github.com/googleworkspace/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            gws CLI
          </a>
        </p>
      </div>
    </aside>
  );
}
