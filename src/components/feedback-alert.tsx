import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export type FeedbackType = "success" | "error" | "warning" | "info";

export interface Feedback {
  type: FeedbackType;
  text: string;
}

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const VARIANTS = {
  success: "success",
  error: "destructive",
  warning: "warning",
  info: "info",
} as const;

/**
 * The one-line outcome banner most pages show after an action ("Successfully
 * added …", "Failed to connect to the API"). Renders nothing when there is
 * no message, so callers can pass their state straight through.
 */
export function FeedbackAlert({
  message,
  className,
}: {
  message: Feedback | null | undefined;
  className?: string;
}) {
  if (!message) return null;
  const Icon = ICONS[message.type];
  return (
    <Alert variant={VARIANTS[message.type]} className={className}>
      <Icon />
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}
