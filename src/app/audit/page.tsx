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
import { Search, Loader2, Shield, FileText } from "lucide-react";

export default function Audit() {
  const [user, setUser] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState("");
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
      const res = await fetch("/api/ai/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user }),
      });
      const result = await res.json();

      if (result.success) {
        setSummary(result.data.summary);
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

  // Simple markdown-ish rendering: bold, bullets, headers
  const renderSummary = (text: string) => {
    return text.split("\n").map((line, i) => {
      // Headers
      if (line.startsWith("## ")) {
        return (
          <h3 key={i} className="text-base font-semibold mt-4 mb-2">
            {line.replace("## ", "")}
          </h3>
        );
      }
      if (line.startsWith("# ")) {
        return (
          <h2 key={i} className="text-lg font-semibold mt-4 mb-2">
            {line.replace("# ", "")}
          </h2>
        );
      }

      // Bold text with **
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const rendered = parts.map((part, j) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={j}>{part.slice(2, -2)}</strong>
          );
        }
        return part;
      });

      // Bullet points
      if (line.startsWith("- ") || line.startsWith("* ")) {
        return (
          <li key={i} className="text-sm ml-4 list-disc">
            {rendered.map((r, idx) =>
              typeof r === "string" ? (idx === 0 ? r.slice(2) : r) : r
            )}
          </li>
        );
      }

      // Empty line
      if (line.trim() === "") {
        return <br key={i} />;
      }

      // Regular text
      return (
        <p key={i} className="text-sm">
          {rendered}
        </p>
      );
    });
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
              ? "border-red-200 bg-red-50"
              : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <AlertDescription
            className={
              message.type === "error" ? "text-red-800" : "text-emerald-800"
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
                  onKeyDown={(e) => e.key === "Enter" && runAudit()}
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
                Audit Report — {user}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm max-w-none">
                {renderSummary(summary)}
              </div>
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
