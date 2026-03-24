import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 401 &&
      !error.config?.url?.includes('/auth/')
    ) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// CSRF token cache + auto-inject on mutating requests
let _csrfToken = null;
async function getCsrfToken() {
  if (_csrfToken) return _csrfToken;
  const res = await api.get('/auth/csrf-token');
  _csrfToken = res.data.csrfToken;
  return _csrfToken;
}

api.interceptors.request.use(async (config) => {
  if (['post', 'put', 'patch', 'delete'].includes(config.method?.toLowerCase())) {
    try {
      const token = await getCsrfToken();
      config.headers['x-csrf-token'] = token;
    } catch {}
  }
  return config;
});

// Auth — OTP flow
export const requestLoginCode = (identifier) =>
  api.post('/auth/login-request', { identifier }).then(r => r.data);

export const verifyLoginCode = (identifier, code, rememberMe) =>
  api.post('/auth/login-verify', { identifier, code, rememberMe }).then(r => r.data);

export const logout = () =>
  api.post('/auth/logout').then(r => r.data);

export const getMe = () =>
  api.get('/auth/me').then(r => r.data);

// Users — Admin management
export const getUsers = () =>
  api.get('/users').then(r => r.data);

export const getUser = (id) =>
  api.get(`/users/${id}`).then(r => r.data);

export const createUserAccount = (data) =>
  api.post('/users', data).then(r => r.data);

export const updateUserAccount = (id, data) =>
  api.patch(`/users/${id}`, data).then(r => r.data);

export const deleteUserAccount = (id) =>
  api.delete(`/users/${id}`).then(r => r.data);

export const setUserPermissions = (id, shopPermissions) =>
  api.put(`/users/${id}/permissions`, { shopPermissions }).then(r => r.data);

// Shops
export const getShops = () =>
  api.get('/shops').then(r => r.data);

export const getShop = (slug) =>
  api.get(`/shops/${slug}`).then(r => r.data);

export const createShop = (data) =>
  api.post('/shops', data).then(r => r.data);

export const updateShop = (slug, data) =>
  api.patch(`/shops/${slug}`, data).then(r => r.data);

export const deleteShop = (slug, deleteFiles = false) =>
  api.delete(`/shops/${slug}?deleteFiles=${deleteFiles}`).then(r => r.data);

export const shopAction = (slug, action) =>
  api.post(`/shops/${slug}/${action}`).then(r => r.data);

export const deployShop = (slug) =>
  api.post(`/shops/${slug}/deploy`).then(r => r.data);

export const getShopLogs = (slug, lines = 100) =>
  api.get(`/shops/${slug}/logs?lines=${lines}`).then(r => r.data);

export const getShopVersion = (slug) =>
  api.get(`/shops/${slug}/version`).then(r => r.data);

export const upgradeShop = (slug) =>
  api.post(`/shops/${slug}/upgrade`, { confirm: true }).then(r => r.data);

// Orders
export const getOrders = (slug) =>
  api.get(`/shops/${slug}/orders`).then(r => r.data);

export const getOrdersDownloadUrl = (slug) =>
  `/api/shops/${slug}/orders/download`;

export const wipeOrders = (slug) =>
  api.post(`/shops/${slug}/orders/wipe`).then(r => r.data);

export const getPoFileUrl = (slug, filename) =>
  `/api/shops/${slug}/orders/po?filename=${encodeURIComponent(filename)}`;

export const getProductImageUrl = (slug, productId) =>
  `/api/shops/${slug}/orders/product-image/${encodeURIComponent(productId)}`;

export const getCatalogPhotos = (slug) =>
  api.get(`/shops/${slug}/orders/catalog-photos`).then(r => r.data);

export const shipOrder = (slug, orderId, trackingNumber) =>
  api.post(`/shops/${slug}/orders/${encodeURIComponent(orderId)}/ship`, { trackingNumber }).then(r => r.data);

export const cancelOrder = (slug, orderId, reason) =>
  api.post(`/shops/${slug}/orders/${encodeURIComponent(orderId)}/cancel`, { reason }).then(r => r.data);

// Shop Files
export const listShopFiles = (slug, dirPath = '.') =>
  api.get(`/shops/${slug}/files`, { params: { path: dirPath } }).then(r => r.data);

export const readShopFile = (slug, filePath) =>
  api.get(`/shops/${slug}/files/read`, { params: { path: filePath } }).then(r => r.data);

export const writeShopFile = (slug, filePath, content) =>
  api.put(`/shops/${slug}/files/write`, { content }, { params: { path: filePath } }).then(r => r.data);

export const deleteShopFile = (slug, filePath) =>
  api.delete(`/shops/${slug}/files`, { params: { path: filePath } }).then(r => r.data);

export const getShopImageUrl = (slug, filePath) =>
  `/api/shops/${slug}/files/image?path=${encodeURIComponent(filePath)}`;

export const uploadShopFiles = (slug, dirPath, formData) =>
  api.post(`/shops/${slug}/files/upload`, formData, {
    params: { path: dirPath },
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);

export const replaceShopFile = (slug, filePath, file) => {
  const formData = new FormData();
  formData.append('file', file);
  return api.post(`/shops/${slug}/files/replace`, formData, {
    params: { path: filePath },
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};

export const uploadDatabaseZip = (slug, dirPath, file) => {
  const formData = new FormData();
  formData.append('file', file);
  return api.post(`/shops/${slug}/files/upload-zip`, formData, {
    params: { path: dirPath },
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};

// Inventory
export const getInventory = (slug) =>
  api.get(`/shops/${slug}/inventory`).then(r => r.data);

export const seedInventory = (slug) =>
  api.post(`/shops/${slug}/inventory/seed`).then(r => r.data);

export const updateInventoryBulk = (slug, updates) =>
  api.patch(`/shops/${slug}/inventory/bulk`, { updates }).then(r => r.data);

export const updateInventoryItem = (slug, productId, data) =>
  api.patch(`/shops/${slug}/inventory/${productId}`, data).then(r => r.data);

export const getInventorySummary = (slug) =>
  api.get(`/shops/${slug}/inventory/summary`).then(r => r.data);

// Shop Template Updates
export const checkShopUpdate = (slug) =>
  api.get(`/shops/${slug}/check-update`).then(r => r.data);

export const installShopUpdate = (slug) =>
  api.post(`/shops/${slug}/update-template`).then(r => r.data);

// System / Updates
export const getSystemVersion = () =>
  api.get('/system/version').then(r => r.data);

export const checkForUpdate = () =>
  api.get('/system/check-update').then(r => r.data);

export const installUpdate = (branch) =>
  api.post('/system/update', branch ? { branch } : {}).then(r => r.data);

export const getSystemBranches = () =>
  api.get('/system/branches').then(r => r.data);

// Mission Control
export const getMissionOverview = () =>
  api.get('/mission-control/overview').then(r => r.data);

export const getSystemLogs = (lines = 200) =>
  api.get(`/mission-control/logs/system?lines=${lines}`).then(r => r.data);

export const getShopMissionLogs = (slug, lines = 100) =>
  api.get(`/mission-control/logs/shop/${slug}?lines=${lines}`).then(r => r.data);

export const getAllShopLogs = (lines = 50) =>
  api.get(`/mission-control/logs/all?lines=${lines}`).then(r => r.data);

export const getMissionErrors = () =>
  api.get('/mission-control/errors').then(r => r.data);

export const getMissionSecurity = () =>
  api.get('/mission-control/security').then(r => r.data);

export const getMissionAnalytics = () =>
  api.get('/mission-control/analytics').then(r => r.data);

// Analytics
export const getAnalyticsOverview = (slug, range = '7d') =>
  api.get(`/shops/${slug}/analytics/overview?range=${range}`).then(r => r.data);

export const getAnalyticsTimeseries = (slug, range = '7d', interval) =>
  api.get(`/shops/${slug}/analytics/timeseries?range=${range}${interval ? `&interval=${interval}` : ''}`).then(r => r.data);

export const getAnalyticsCountries = (slug, range = '7d') =>
  api.get(`/shops/${slug}/analytics/countries?range=${range}`).then(r => r.data);

export const getAnalyticsPages = (slug, range = '7d') =>
  api.get(`/shops/${slug}/analytics/pages?range=${range}`).then(r => r.data);

export const getAnalyticsProducts = (slug, range = '7d') =>
  api.get(`/shops/${slug}/analytics/products?range=${range}`).then(r => r.data);

// Health check — resolves true if backend reachable, false otherwise
export const checkHealth = () =>
  api.get('/health', { timeout: 5000 }).then(() => true).catch(() => false);

export default api;
