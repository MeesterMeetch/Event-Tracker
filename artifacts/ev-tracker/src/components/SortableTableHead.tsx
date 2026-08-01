import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { SortDir } from "@/hooks/use-table-sort";

interface Props {
  columnKey: string;
  activeKey: string | null;
  direction: SortDir;
  onSort: (key: string) => void;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
}

/**
 * A TableHead whose label is a button cycling this column's sort state. Shows a
 * neutral chevron until the column is active, so every sortable column
 * advertises itself without implying it's currently applied.
 */
export function SortableTableHead({
  columnKey,
  activeKey,
  direction,
  onSort,
  children,
  className,
  align = "left",
}: Props) {
  const isActive = activeKey === columnKey;
  const Icon = !isActive ? ChevronsUpDown : direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <TableHead
      className={cn(align === "right" && "text-right", align === "center" && "text-center", className)}
      aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          align === "right" && "flex-row-reverse",
          isActive && "text-foreground",
        )}
      >
        {children}
        <Icon className={cn("h-3 w-3 shrink-0", !isActive && "opacity-40")} />
      </button>
    </TableHead>
  );
}
