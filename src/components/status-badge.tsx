import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "success" | "error" | "pending" | "idle";

const statusConfig: Record<Status, { label: string; className: string }> = {
  success: {
    label: "Success",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  error: {
    label: "Error",
    className: "bg-red-100 text-red-800 border-red-200",
  },
  pending: {
    label: "Running...",
    className: "bg-amber-100 text-amber-800 border-amber-200",
  },
  idle: {
    label: "Ready",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
  },
};

export function StatusBadge({
  status,
  label,
}: {
  status: Status;
  label?: string;
}) {
  const config = statusConfig[status];
  return (
    <Badge variant="outline" className={cn("font-medium", config.className)}>
      {label || config.label}
    </Badge>
  );
}
