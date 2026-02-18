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

export const createShop = (data) =>
  api.post('/shops', data).then(r => r.data);

export const deleteShop = (slug, deleteFiles = false) =>
  api.delete(`/shops/${slug}?deleteFiles=${deleteFiles}`).then(r => r.data);

export const shopAction = (slug, action) =>
  api.post(`/shops/${slug}/${action}`).then(r => r.data);

export const deployShop = (slug) =>
  api.post(`/shops/${slug}/deploy`).then(r => r.data);

export const getShopLogs = (slug) =>
  api.get(`/shops/${slug}/logs`).then(r => r.data);

// Orders
export const getOrders = (slug) =>
  api.get(`/shops/${slug}/orders`).then(r => r.data);

export const getOrdersDownloadUrl = (slug) =>
  `/api/shops/${slug}/orders/download`;

// Shop Database
export const getShopDatabases = (slug) =>
  api.get(`/shops/${slug}/db`).then(r => r.data);

export const getShopTables = (slug, file) =>
  api.get(`/shops/${slug}/db/tables`, { params: { file } }).then(r => r.data);

export const getShopRows = (slug, file, table) =>
  api.get(`/shops/${slug}/db/rows`, { params: { file, table } }).then(r => r.data);

export const insertShopRow = (slug, file, table, data) =>
  api.post(`/shops/${slug}/db/rows`, { file, table, data }).then(r => r.data);

export const updateShopRow = (slug, file, table, rowid, data) =>
  api.put(`/shops/${slug}/db/rows/${rowid}`, { file, table, data }).then(r => r.data);

export const deleteShopRow = (slug, file, table, rowid) =>
  api.delete(`/shops/${slug}/db/rows/${rowid}`, { params: { file, table } }).then(r => r.data);

export default api;
