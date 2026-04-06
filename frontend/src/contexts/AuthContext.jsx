import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { get, post } from '../api';

const AuthContext = createContext(null);

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized));
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [role, setRole] = useState(localStorage.getItem('role'));
  const [accountId, setAccountId] = useState(localStorage.getItem('accountId'));
  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);

  async function fetchProfile(currentRole) {
    if (!token || !currentRole) {
      setProfile(null);
      return;
    }

    setLoadingProfile(true);
    try {
      if (currentRole === 'regular') {
        setProfile(await get('/users/me'));
      } else if (currentRole === 'business') {
        setProfile(await get('/businesses/me'));
      } else {
        setProfile({ id: Number(accountId), role: 'admin' });
      }
    } catch {
      setProfile(null);
    } finally {
      setLoadingProfile(false);
    }
  }

  useEffect(() => {
    fetchProfile(role);
  }, [role, token]);

  async function login(email, password) {
    const data = await post('/auth/tokens', { email, password });
    localStorage.setItem('token', data.token);
    setToken(data.token);

    const payload = decodeJwtPayload(data.token);
    const payloadRole = payload?.role || null;
    const payloadSub = payload?.sub ? String(payload.sub) : null;

    if (payloadRole) {
      localStorage.setItem('role', payloadRole);
      setRole(payloadRole);
    }
    if (payloadSub) {
      localStorage.setItem('accountId', payloadSub);
      setAccountId(payloadSub);
    }

    return data;
  }

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('role');
    localStorage.removeItem('accountId');
    setToken(null);
    setRole(null);
    setAccountId(null);
    setProfile(null);
  }

  const value = useMemo(
    () => ({
      token,
      role,
      accountId,
      profile,
      loadingProfile,
      login,
      logout,
      refreshProfile: () => fetchProfile(role),
    }),
    [token, role, accountId, profile, loadingProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
