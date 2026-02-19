// lib/api.ts - API utility for base path routing
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const basePath = BASE_PATH;

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${BASE_PATH}/api/${cleanPath}`;
}

export async function apiFetch(path: string, options?: RequestInit) {
  return fetch(apiUrl(path), options);
}
