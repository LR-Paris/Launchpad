import { createContext, useContext } from 'react';

const PermissionsContext = createContext(null);

export function PermissionsProvider({ user, children }) {
  return (
    <PermissionsContext.Provider value={user}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  const user = useContext(PermissionsContext);
  if (!user) {
    return {
      user: null,
      role: null,
      isSuperAdmin: false,
      isAdmin: false,
      isAdminOrAbove: false,
      canManageUsers: false,
      canAccessMissionControl: false,
      canAccessGlobalSettings: false,
      canCreateShops: false,
      getShopPerms: () => ({ can_delete: false, can_edit_ui: false, can_edit_items: false, can_view_orders: false, can_view_analytics: false }),
      canShop: () => false,
    };
  }

  const role = user.role;
  const isSuperAdmin = role === 'super_admin';
  const isAdmin = role === 'admin';
  const isAdminOrAbove = isSuperAdmin || isAdmin;

  // Get permissions for a specific shop
  const getShopPerms = (slug) => {
    if (isAdminOrAbove) {
      return { can_delete: true, can_edit_ui: true, can_edit_items: true, can_view_orders: true, can_view_analytics: true };
    }
    const perms = user.permissions?.[slug];
    return {
      can_delete: !!perms?.can_delete,
      can_edit_ui: !!perms?.can_edit_ui,
      can_edit_items: !!perms?.can_edit_items,
      can_view_orders: !!perms?.can_view_orders,
      can_view_analytics: !!perms?.can_view_analytics,
    };
  };

  // Quick check: does the user have a specific permission for a shop?
  const canShop = (slug, permission) => {
    if (isAdminOrAbove) return true;
    return !!user.permissions?.[slug]?.[permission];
  };

  return {
    user,
    role,
    isSuperAdmin,
    isAdmin,
    isAdminOrAbove,
    canManageUsers: isSuperAdmin,
    canAccessMissionControl: isAdminOrAbove,
    canAccessGlobalSettings: isAdminOrAbove,
    canCreateShops: isAdminOrAbove || !!user.can_create_shops,
    getShopPerms,
    canShop,
  };
}
