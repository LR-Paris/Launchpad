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

// Auth
export const login = (username, password) =>
  api.post('/auth/login', { username, password }).then(r => r.data);

export const logout = () =>
  api.post('/auth/logout').then(r => r.data);

export const getMe = () =>
  api.get('/auth/me').then(r => r.data);

export const changePassword = (oldPassword, newPassword) =>
  api.post('/auth/change-password', { oldPassword, newPassword }).then(r => r.data);

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
  `/api/shops/${slug}/orders/po/${encodeURIComponent(filename)}`;

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

export const installUpdate = () =>
  api.post('/system/update').then(r => r.data);

export default api;
