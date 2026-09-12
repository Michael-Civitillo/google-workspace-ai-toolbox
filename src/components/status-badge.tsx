import { Badge } from "@/components/ui/badge";

type Status = "success" | "error" | "pending" | "idle";

const statusConfig: Record<
  Status,
  { label: string; variant: "success" | "destructive" | "warning" | "outline" }
> = {
  success: { label: "Success", variant: "success" },
  error: { label: "Error", variant: "destructive" },
  pending: { label: "Running...", variant: "warning" },
  idle: { label: "Ready", variant: "outline" },
};

export function StatusBadge({
  status,
  label,
}: {
  status: Status;
  label?: string;
}) {
  const config = statusConfig[status];
  return <Badge variant={config.variant}>{label || config.label}</Badge>;
}
