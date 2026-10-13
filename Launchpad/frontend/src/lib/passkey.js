// lib/passkey.js — browser side of the WebAuthn ceremonies.
// Thin wrappers over @simplewebauthn/browser (v14, object-arg form) + the API.
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import api from './api';

// True when the browser can do WebAuthn at all.
export function passkeySupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

// Register a new passkey for the signed-in user. `nickname` is optional.
export async function registerPasskey(nickname) {
  const { data: optionsJSON } = await api.post('/auth/passkey/register-options', {});
  const attResp = await startRegistration({ optionsJSON });
  const { data } = await api.post('/auth/passkey/register-verify', { ...attResp, nickname });
  return data;
}

// Sign in with a passkey (usernameless/discoverable). Returns the user payload.
export async function loginWithPasskey(rememberMe) {
  const { data: optionsJSON } = await api.post('/auth/passkey/auth-options', {});
  const asgResp = await startAuthentication({ optionsJSON });
  const { data } = await api.post('/auth/passkey/auth-verify', { ...asgResp, rememberMe });
  return data;
}

export async function listPasskeys() {
  const { data } = await api.get('/auth/passkey/list');
  return data.passkeys || [];
}

export async function deletePasskey(credentialId) {
  const { data } = await api.delete(`/auth/passkey/${encodeURIComponent(credentialId)}`);
  return data;
}
