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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { ArrowRightLeft, Loader2, ArrowRight, Info } from "lucide-react";

export default function EmailTransfer() {
  const [sourceUser, setSourceUser] = useState("");
  const [targetUser, setTargetUser] = useState("");
  const [action, setAction] = useState("keep");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const transferEmail = async () => {
    if (!sourceUser || !targetUser) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/gws/email-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUser, targetUser, action }),
      });
      const result = await res.json();

      if (result.success) {
        setMessage({
          type: "success",
          text: `Email forwarding set up from ${sourceUser} to ${targetUser}. New emails will be forwarded automatically.`,
        });
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to set up email transfer",
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
        title="Email Transfer"
        description="Set up automatic email forwarding from one user to another. Ideal for offboarding or role transitions."
        badge="Gmail"
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

      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Set Up Email Forwarding
            </CardTitle>
            <CardDescription>
              Creates a forwarding address and enables automatic forwarding for
              all incoming mail.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-end gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="source">Source User</Label>
                <Input
                  id="source"
                  placeholder="departing@yourdomain.com"
                  value={sourceUser}
                  onChange={(e) => setSourceUser(e.target.value)}
                />
              </div>
              <div className="pb-2">
                <ArrowRight className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 space-y-2">
                <Label htmlFor="target">Target User</Label>
                <Input
                  id="target"
                  placeholder="receiving@yourdomain.com"
                  value={targetUser}
                  onChange={(e) => setTargetUser(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>After Forwarding</Label>
              <Select value={action} onValueChange={(v) => v && setAction(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">
                    Keep in inbox (recommended)
                  </SelectItem>
                  <SelectItem value="archive">Archive original</SelectItem>
                  <SelectItem value="trash">Move to trash</SelectItem>
                  <SelectItem value="markRead">Mark as read</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                What happens to the original email in the source mailbox after
                it&apos;s forwarded.
              </p>
            </div>

            <Alert className="border-blue-200 bg-blue-50">
              <Info className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 text-sm">
                This sets up forwarding for <strong>new</strong> incoming email
                only. Existing emails are not transferred. For existing mail
                migration, use Google&apos;s Data Migration Service in the Admin
                Console.
              </AlertDescription>
            </Alert>

            <Button
              className="w-full"
              size="lg"
              onClick={transferEmail}
              disabled={!sourceUser || !targetUser || loading}
            >
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="mr-2 h-4 w-4" />
              )}
              Set Up Forwarding
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
