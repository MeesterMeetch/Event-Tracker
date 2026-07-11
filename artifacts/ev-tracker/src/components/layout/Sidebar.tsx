import { Link, useLocation } from "wouter";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { Activity, LayoutDashboard, ListTodo, Trophy, X } from "lucide-react";

export function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/edges", label: "Live Edges", icon: Activity },
    { href: "/rankings", label: "Rankings", icon: Trophy },
    { href: "/bets", label: "Bet Log", icon: ListTodo },
  ];

  // Close the mobile drawer automatically whenever the route changes.
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  return (
    <>
      {/* Backdrop: only present (and clickable) on mobile while the drawer is open */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60 transition-opacity md:hidden",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className={cn(
          "fixed left-0 top-0 bottom-0 z-50 w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          "transition-transform duration-200 ease-in-out",
          "md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-16 items-center justify-between px-6 border-b border-sidebar-border">
          <h1 className="font-mono text-xl font-bold tracking-tight text-primary">
            EV_TERMINAL<span className="animate-pulse">_</span>
          </h1>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="md:hidden text-muted-foreground hover:text-sidebar-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <item.icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-muted-foreground")} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
