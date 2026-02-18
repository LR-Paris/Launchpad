import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getMe } from './lib/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import NewShop from './pages/NewShop';
import Orders from './pages/Orders';
import Settings from './pages/Settings';
import Header from './components/Header';

function ProtectedRoute({ children, user }) {
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { data, isLoading } = useQuery({
    queryKey: ['auth'],
    queryFn: getMe,
    retry: false,
  });

  const user = data?.user || null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {user && <Header user={user} />}
      <main className="max-w-6xl mx-auto px-4 py-6 flex-1 w-full">
        <Routes>
          <Route
            path="/login"
            element={user ? <Navigate to="/" replace /> : <Login />}
          />
          <Route
            path="/"
            element={
              <ProtectedRoute user={user}>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/shops/new"
            element={
              <ProtectedRoute user={user}>
                <NewShop />
              </ProtectedRoute>
            }
          />
          <Route
            path="/shops/:slug/orders"
            element={
              <ProtectedRoute user={user}>
                <Orders />
              </ProtectedRoute>
            }
          />
          <Route
            path="/shops/:slug/settings"
            element={
              <ProtectedRoute user={user}>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="border-t py-3 text-center text-xs text-muted-foreground">
        Launchpad LC-1.1 &middot; Shuttle Template LC-0.12
      </footer>
    </div>
  );
}
