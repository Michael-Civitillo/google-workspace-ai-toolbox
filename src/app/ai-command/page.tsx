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
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import {
  Sparkles,
  Loader2,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Play,
} from "lucide-react";

interface ParsedAction {
  action: string;
  params: Record<string, string>;
  confidence: number;
  explanation: string;
  actionDetails: {
    name: string;
    endpoint: string;
    method: string;
  } | null;
}

export default function AICommand() {
  const [command, setCommand] = useState("");
  const [parsed, setParsed] = useState<ParsedAction | null>(null);
  const [parsing, setParsing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const parseCommand = async () => {
    if (!command.trim()) return;
    setParsing(true);
    setParsed(null);
    setMessage(null);

    try {
      const res = await fetch("/api/ai/parse-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const result = await res.json();

      if (result.success) {
        setParsed(result.data);
      } else {
        setMessage({ type: "error", text: result.error || "Failed to parse" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to the API" });
    } finally {
      setParsing(false);
    }
  };

  const executeAction = async () => {
    if (!parsed?.actionDetails) return;
    setExecuting(true);
    setMessage(null);

    try {
      const { endpoint, method } = parsed.actionDetails;
      const fetchOptions: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };

      let url = endpoint;
      if (method === "GET") {
        const params = new URLSearchParams(parsed.params);
        url = `${endpoint}?${params.toString()}`;
      } else {
        fetchOptions.body = JSON.stringify(parsed.params);
      }

      const res = await fetch(url, fetchOptions);
      const result = await res.json();

      if (result.success) {
        setMessage({
          type: "success",
          text: `Done! ${parsed.explanation}`,
        });
        setParsed(null);
        setCommand("");
      } else {
        setMessage({
          type: "error",
          text: result.error || "Action failed",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to execute action" });
    } finally {
      setExecuting(false);
    }
  };

  const confidenceColor =
    parsed && parsed.confidence >= 0.8
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : parsed && parsed.confidence >= 0.5
        ? "bg-amber-100 text-amber-700 border-amber-200"
        : "bg-red-100 text-red-700 border-red-200";

  return (
    <>
      <PageHeader
        title="AI Command"
        description="Type what you want to do in plain English. The AI figures out the rest."
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
        {/* Command Input */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-500" />
              What do you need?
            </CardTitle>
            <CardDescription>
              Describe the admin task in your own words.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder={`e.g. "Give sarah@company.com access to john@company.com's mailbox"`}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && parseCommand()}
                className="text-base"
              />
              <Button onClick={parseCommand} disabled={!command.trim() || parsing}>
                {parsing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                "Delegate jane@co.com's email to mike@co.com",
                "Share alice@co.com's calendar with bob@co.com as editor",
                "Forward all email from old@co.com to new@co.com",
                "Who has access to ceo@co.com's calendar?",
              ].map((example) => (
                <button
                  key={example}
                  onClick={() => setCommand(example)}
                  className="text-xs px-2.5 py-1.5 rounded-full border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  {example}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Parsed Result */}
        {parsed && (
          <Card className="border-violet-200">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Parsed Action</CardTitle>
                <Badge variant="outline" className={confidenceColor}>
                  {Math.round(parsed.confidence * 100)}% confident
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-4 rounded-lg bg-muted/50 space-y-3">
                <div className="flex items-center gap-2">
                  <Badge className="bg-violet-100 text-violet-700 border-violet-200">
                    {parsed.actionDetails?.name || parsed.action}
                  </Badge>
                </div>
                <p className="text-sm">{parsed.explanation}</p>

                <Separator />

                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Parameters
                  </p>
                  {Object.entries(parsed.params).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-muted-foreground min-w-[120px]">
                        {key}:
                      </span>
                      <code className="bg-muted px-2 py-0.5 rounded text-sm">
                        {value}
                      </code>
                    </div>
                  ))}
                </div>
              </div>

              {parsed.confidence < 0.7 && (
                <Alert className="border-amber-200 bg-amber-50">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <AlertDescription className="text-amber-800 text-sm">
                    The AI isn&apos;t very confident about this interpretation.
                    Double-check the parameters before running.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex gap-3">
                <Button
                  className="flex-1"
                  size="lg"
                  onClick={executeAction}
                  disabled={executing}
                >
                  {executing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  Run It
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => setParsed(null)}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* How it works */}
        {!parsed && !parsing && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start gap-4 text-sm text-muted-foreground">
                <CheckCircle2 className="h-5 w-5 text-violet-400 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-foreground mb-1">
                    How it works
                  </p>
                  <p>
                    Type what you want in plain English. The AI parses your
                    intent, shows you exactly what it&apos;ll do, and waits for
                    your confirmation before executing. Nothing runs without
                    your OK.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
