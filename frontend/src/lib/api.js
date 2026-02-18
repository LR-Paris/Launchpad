import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Redirect to login on 401 responses (except for /auth/ endpoints)
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

// Orders
export const getOrders = (slug) =>
  api.get(`/shops/${slug}/orders`).then(r => r.data);

export const getOrdersDownloadUrl = (slug) =>
  `/api/shops/${slug}/orders/download`;

// Shop Files
export const listShopFiles = (slug, dirPath = '.') =>
  api.get(`/shops/${slug}/files`, { params: { path: dirPath } }).then(r => r.data);

export const readShopFile = (slug, filePath) =>
  api.get(`/shops/${slug}/files/read`, { params: { path: filePath } }).then(r => r.data);

export const writeShopFile = (slug, filePath, content) =>
  api.put(`/shops/${slug}/files/write`, { content }, { params: { path: filePath } }).then(r => r.data);

export const uploadShopFiles = (slug, dirPath, formData) =>
  api.post(`/shops/${slug}/files/upload`, formData, {
    params: { path: dirPath },
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);

// Auth
export const changePassword = (oldPassword, newPassword) =>
  api.post('/auth/change-password', { oldPassword, newPassword }).then(r => r.data);

export default api;
