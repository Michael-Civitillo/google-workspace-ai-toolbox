import { Badge } from "@/components/ui/badge";

interface PageHeaderProps {
  title: string;
  description: string;
  badge?: string;
}

export function PageHeader({ title, description, badge }: PageHeaderProps) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="text-muted-foreground">{description}</p>
    </div>
  );
}
