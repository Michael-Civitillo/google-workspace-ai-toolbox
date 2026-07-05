"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { AiSummary } from "@/components/ai-summary";
import { Search, Loader2, Shield, FileText } from "lucide-react";
import { tfetch } from "@/lib/tenant-client";

export default function Audit() {
  const [user, setUser] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState("");
  // The user the displayed report actually belongs to. The header must not
  // render the live input — typing the NEXT audit's address would relabel the
  // still-displayed findings as someone else's.
  const [summaryUser, setSummaryUser] = useState("");
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const runAudit = async () => {
    if (!user.trim()) return;
    setLoading(true);
    setSummary("");
    setMessage(null);

    try {
      const res = await tfetch("/api/ai/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: user.trim() }),
      });
      const result = await res.json();

      if (result.success) {
        setSummary(result.data.summary);
        setSummaryUser(result.data.user || user.trim());
      } else {
        setMessage({
          type: "error",
          text: result.error || "Audit failed",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="User Audit"
        description="Enter a user's email and get a full AI-powered breakdown of their email delegates, calendar sharing, forwarding, and potential security concerns."
        badge="Gemini"
      />

      {message && (
        <Alert
          className={`mb-6 ${
            message.type === "error"
              ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40"
              : "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40"
          }`}
        >
          <AlertDescription
            className={
              message.type === "error" ? "text-red-800 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"
            }
          >
            {message.text}
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-3xl space-y-6">
        {/* Input */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Run User Audit
            </CardTitle>
            <CardDescription>
              Pulls email delegates, calendar sharing rules, forwarding settings,
              and mailbox info — then summarizes it all.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user">User Email</Label>
              <div className="flex gap-2">
                <Input
                  id="user"
                  placeholder="user@yourdomain.com"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !loading && runAudit()}
                />
                <Button
                  onClick={runAudit}
                  disabled={!user.trim() || loading}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Loading */}
        {loading && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
                <div className="text-center">
                  <p className="font-medium text-foreground">
                    Running audit...
                  </p>
                  <p className="text-sm">
                    Pulling data from Gmail and Calendar APIs, then
                    generating the report.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {summary && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Audit Report — {summaryUser}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AiSummary text={summary} />
              <Separator className="my-4" />
              <p className="text-xs text-muted-foreground">
                Generated by Gemini based on live API data. Always verify
                critical findings manually.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
