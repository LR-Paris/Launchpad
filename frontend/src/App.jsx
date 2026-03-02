import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getMe } from './lib/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import NewShop from './pages/NewShop';
import Orders from './pages/Orders';
import Catalog from './pages/Catalog';
import Settings from './pages/Settings';
import GlobalSettings from './pages/GlobalSettings';
import Header from './components/Header';

function ProtectedRoute({ children, user }) {
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('lp-theme') || 'dark');

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    localStorage.setItem('lp-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  const { data, isLoading } = useQuery({
    queryKey: ['auth'],
    queryFn: getMe,
    retry: false,
  });

  const user = data?.user || null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen gap-2">
        <span className="term-cursor" />
        <p className="text-muted-foreground text-sm font-mono">Initializing...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {user && <Header user={user} theme={theme} toggleTheme={toggleTheme} />}
      <main className="max-w-6xl mx-auto px-4 py-8 flex-1 w-full">
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
            path="/shops/:slug/catalog"
            element={
              <ProtectedRoute user={user}>
                <Catalog />
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
          <Route
            path="/settings"
            element={
              <ProtectedRoute user={user}>
                <GlobalSettings theme={theme} toggleTheme={toggleTheme} />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="border-t border-border/40 py-3 text-center">
        <span className="text-xs font-mono text-muted-foreground/60">
          Launchpad{' '}
          <span className="text-[hsl(188,100%,42%)/70]">{`LC-${__APP_VERSION__}`}</span>
        </span>
      </footer>
    </div>
  );
}
