import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import Dashboard from '@/pages/Dashboard';
import LiveEdges from '@/pages/LiveEdges';
import Rankings from '@/pages/Rankings';
import BetLog from '@/pages/BetLog';

// Odds-backed queries cost live API credits, so never refetch just because
// the window regained focus, and treat results as fresh for a minute.
// Mutations still invalidate their queries explicitly, which bypasses both.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60 * 1000,
    },
  },
});

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-4">
      <h1 className="text-4xl font-bold font-mono text-destructive">404</h1>
      <p className="text-muted-foreground max-w-md">The route you are looking for does not exist in this terminal.</p>
    </div>
  );
}

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/edges" component={LiveEdges} />
        <Route path="/rankings" component={Rankings} />
        <Route path="/bets" component={BetLog} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
