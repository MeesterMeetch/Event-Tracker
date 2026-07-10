import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Activity, LayoutDashboard, ListTodo } from "lucide-react";

export function Sidebar() {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/edges", label: "Live Edges", icon: Activity },
    { href: "/bets", label: "Bet Log", icon: ListTodo },
  ];

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center px-6 border-b border-sidebar-border">
        <h1 className="font-mono text-xl font-bold tracking-tight text-primary">
          EV_TERMINAL<span className="animate-pulse">_</span>
        </h1>
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
  );
}
