"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import {
  Mail,
  CalendarDays,
  ArrowRightLeft,
  Globe,
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  UserMinus,
  Share2,
} from "lucide-react";
import Link from "next/link";
import { AICommandPanel } from "@/components/ai-command-panel";

interface GwsStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
}

const tasks = [
  {
    title: "Email Delegation",
    description: "Grant mailbox access to another user without sharing passwords",
    href: "/email-delegation",
    icon: Mail,
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-50 dark:bg-blue-950/30",
  },
  {
    title: "Calendar Delegation",
    description: "Share calendar access with configurable permission levels",
    href: "/calendar-delegation",
    icon: CalendarDays,
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
  },
  {
    title: "Calendar Transfer",
    description: "Transfer calendar ownership from one user to another",
    href: "/calendar-transfer",
    icon: ArrowRightLeft,
    color: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-50 dark:bg-violet-950/30",
  },
  {
    title: "Email Transfer",
    description: "Set up email forwarding to transfer incoming mail between users",
    href: "/email-transfer",
    icon: ArrowRightLeft,
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30",
  },
  {
    title: "Domain Change",
    description: "Switch a user's primary email to a different domain in your tenant",
    href: "/domain-change",
    icon: Globe,
    color: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-50 dark:bg-rose-950/30",
  },
  {
    title: "Offboarding",
    description: "Run the full offboarding sequence in one go — vacation, forwarding, transfers, suspend",
    href: "/offboarding",
    icon: UserMinus,
    color: "text-orange-600 dark:text-orange-400",
    bg: "bg-orange-50 dark:bg-orange-950/30",
  },
  {
    title: "Sharing Audit",
    description: "Find Drive files a user has shared outside your tenant",
    href: "/sharing-audit",
    icon: Share2,
    color: "text-cyan-600 dark:text-cyan-400",
    bg: "bg-cyan-50 dark:bg-cyan-950/30",
  },
  {
    title: "User Audit",
    description: "Get a full access report for any user — email, calendar, forwarding",
    href: "/audit",
    icon: Shield,
    color: "text-pink-600 dark:text-pink-400",
    bg: "bg-pink-50 dark:bg-pink-950/30",
  },
];

export default function Dashboard() {
  const [status, setStatus] = useState<GwsStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/gws/status")
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => setStatus({ installed: false, authenticated: false }))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Manage your Google Workspace from a single place."
      />

      {/* Status Banner */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h3 className="text-sm font-medium">CLI Status</h3>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    {status?.installed ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-500" />
                    )}
                    <span className="text-sm">
                      {status?.installed
                        ? `gws ${status.version || ""}`
                        : "gws not installed"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {status?.authenticated ? (
                      <Badge
                        variant="outline"
                        className="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50"
                      >
                        Authenticated
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900/50"
                      >
                        Not Authenticated
                      </Badge>
                    )}
                  </div>
                </div>
              )}
            </div>
            {!loading && (!status?.installed || !status?.authenticated) && (
              <Link
                href="/setup"
                className="text-sm font-medium text-primary underline underline-offset-4 hover:no-underline"
              >
                Go to Setup
              </Link>
            )}
          </div>
        </CardContent>
      </Card>

      {/* AI Command */}
      <div className="mb-8">
        <AICommandPanel />
      </div>

      {/* Admin Tasks */}
      <h2 className="text-lg font-semibold mb-3">Admin Tasks</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {tasks.map((task) => (
          <Link key={task.href} href={task.href}>
            <Card className="h-full transition-all hover:shadow-md hover:border-primary/20 cursor-pointer group">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`h-10 w-10 rounded-lg ${task.bg} flex items-center justify-center`}
                  >
                    <task.icon className={`h-5 w-5 ${task.color}`} />
                  </div>
                  <CardTitle className="text-base group-hover:text-primary transition-colors">
                    {task.title}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {task.description}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
