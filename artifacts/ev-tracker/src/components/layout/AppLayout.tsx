import { ReactNode, useState } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";

export function AppLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Mobile top bar with menu trigger; hidden on desktop where the sidebar is always visible */}
      <div className="md:hidden flex h-16 items-center gap-3 px-4 border-b border-sidebar-border bg-sidebar text-sidebar-foreground sticky top-0 z-30">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open menu"
          className="text-muted-foreground hover:text-sidebar-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="font-mono text-lg font-bold tracking-tight text-primary">
          EV_TERMINAL<span className="animate-pulse">_</span>
        </h1>
      </div>

      <main className="md:pl-64">
        <div className="max-w-7xl mx-auto p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
