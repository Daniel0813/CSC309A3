const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  if (!token) {
    return { 'Content-Type': 'application/json' };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export function parseErrorBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { error: raw || 'Request failed' };
  }
}

export async function apiRequest(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  const body = text ? parseErrorBody(text) : {};

  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

export function get(path) {
  return apiRequest(path, { method: 'GET' });
}

export function post(path, payload) {
  return apiRequest(path, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export function patch(path, payload) {
  return apiRequest(path, {
    method: 'PATCH',
    body: JSON.stringify(payload || {}),
  });
}

export function del(path) {
  return apiRequest(path, { method: 'DELETE' });
}

export function putForm(path, file) {
  const token = localStorage.getItem('token');
  const form = new FormData();
  form.set('file', file);
  return fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  }).then(async (res) => {
    const text = await res.text();
    const body = text ? parseErrorBody(text) : {};
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  });
}
