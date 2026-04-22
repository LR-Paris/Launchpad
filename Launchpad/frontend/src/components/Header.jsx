import { useNavigate, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '../lib/api';
import { usePermissions } from '../lib/permissions';
import { LogOut, Rocket, Sun, Moon, Settings, Activity, Users } from 'lucide-react';

export default function Header({ user, theme, toggleTheme }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdminOrAbove, canManageUsers, canCreateShops } = usePermissions();

  const handleLogout = async () => {
    await logout();
    queryClient.setQueryData(['auth'], null);
    navigate('/login');
  };

  return (
    <header className="border-b border-border/60 bg-card/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-md flex items-center justify-center"
                 style={{ background: '#39C5BB' }}>
              <Rocket className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-base tracking-tight lp-glow"
                  style={{ fontFamily: 'Syne, sans-serif' }}>
              Launchpad
            </span>
          </Link>
          {canCreateShops && (
            <Link
              to="/shops/new"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border/60 hover:border-primary/40 rounded-md px-3 py-1.5 transition-all"
            >
              <Rocket className="h-3.5 w-3.5" />
              Launch Shop
            </Link>
          )}
          {isAdminOrAbove && (
            <Link
              to="/mission-control"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border/60 hover:border-primary/40 rounded-md px-3 py-1.5 transition-all"
            >
              <Activity className="h-3.5 w-3.5" />
              Mission Control
            </Link>
          )}
          {isAdminOrAbove && (
            <Link
              to="/settings"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border/60 hover:border-primary/40 rounded-md px-3 py-1.5 transition-all"
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
          )}
          {canManageUsers && (
            <Link
              to="/admin/users"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border/60 hover:border-primary/40 rounded-md px-3 py-1.5 transition-all"
            >
              <Users className="h-3.5 w-3.5" />
              Users
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-muted-foreground">
            <span className="text-[hsl(188,100%,42%)]">●</span>{' '}{user.name || user.username}
            {user.role !== 'user' && (
              <span className="text-[10px] text-muted-foreground/60 ml-1">
                ({user.role === 'super_admin' ? 'super admin' : 'admin'})
              </span>
            )}
          </span>
          <button
            onClick={toggleTheme}
            className="flex items-center justify-center w-8 h-8 text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/40 rounded-md transition-all"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border/40 hover:border-destructive/40 rounded-md px-2.5 py-1.5 transition-all"
          >
            <LogOut className="h-3.5 w-3.5" />
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
