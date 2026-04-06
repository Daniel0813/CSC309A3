import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, patch, post } from '../api';
import { useAuth } from '../contexts/AuthContext';

function usePagedQuery(pathBase) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [keyword, setKeyword] = useState('');
  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (keyword.trim()) {
      params.set('keyword', keyword.trim());
    }
    return `${pathBase}?${params.toString()}`;
  }, [pathBase, page, limit, keyword]);
  return { query, page, setPage, limit, setLimit, keyword, setKeyword };
}

export function LandingPage() {
  return (
    <section className="card">
      <h1>Dental Temping Workflow Hub</h1>
      <p>
        Find and fill short-term dental shifts with role-aware workflows for professionals,
        clinics, and administrators.
      </p>
      <div className="row">
        <Link className="btn" to="/register/regular">Create Regular Account</Link>
        <Link className="btn" to="/register/business">Create Business Account</Link>
        <Link className="btn" to="/login">Sign In</Link>
      </div>
    </section>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login, role } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (role === 'regular') navigate('/regular/profile');
    if (role === 'business') navigate('/business/profile');
    if (role === 'admin') navigate('/admin/users');
  }, [role]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Login</h2>
      <form onSubmit={submit} className="stack">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" />
        <button className="btn" type="submit">Login</button>
      </form>
      <Link to="/password/reset/request">Forgot password?</Link>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export function RegisterRegularPage() {
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    password: '',
    phone_number: '',
    postal_address: '',
    birthday: '1970-01-01',
  });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      setResult(await post('/users', form));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Register as Regular User</h2>
      <form onSubmit={submit} className="grid-form">
        {Object.keys(form).map((key) => (
          <input
            key={key}
            value={form[key]}
            onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
            placeholder={key}
          />
        ))}
        <button className="btn" type="submit">Create Account</button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && (
        <pre className="codebox">{JSON.stringify(result, null, 2)}</pre>
      )}
    </section>
  );
}

export function RegisterBusinessPage() {
  const [form, setForm] = useState({
    business_name: '',
    owner_name: '',
    email: '',
    password: '',
    phone_number: '',
    postal_address: '',
    location: { lon: -79.39, lat: 43.66 },
  });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      setResult(await post('/businesses', form));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Register as Business</h2>
      <form onSubmit={submit} className="grid-form">
        <input value={form.business_name} onChange={(e) => setForm((p) => ({ ...p, business_name: e.target.value }))} placeholder="business_name" />
        <input value={form.owner_name} onChange={(e) => setForm((p) => ({ ...p, owner_name: e.target.value }))} placeholder="owner_name" />
        <input value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} placeholder="email" />
        <input value={form.password} onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} placeholder="password" type="password" />
        <input value={form.phone_number} onChange={(e) => setForm((p) => ({ ...p, phone_number: e.target.value }))} placeholder="phone_number" />
        <input value={form.postal_address} onChange={(e) => setForm((p) => ({ ...p, postal_address: e.target.value }))} placeholder="postal_address" />
        <input value={form.location.lon} onChange={(e) => setForm((p) => ({ ...p, location: { ...p.location, lon: Number(e.target.value) } }))} placeholder="lon" type="number" />
        <input value={form.location.lat} onChange={(e) => setForm((p) => ({ ...p, location: { ...p.location, lat: Number(e.target.value) } }))} placeholder="lat" type="number" />
        <button className="btn" type="submit">Create Business</button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && <pre className="codebox">{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}

export function PasswordResetRequestPage() {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      setResult(await post('/auth/resets', { email }));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Request Password Reset</h2>
      <form onSubmit={submit} className="stack">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
        <button className="btn" type="submit">Request Reset Token</button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && <pre className="codebox">{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}

export function PasswordResetCompletePage() {
  const { token } = useParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const payload = { email };
      if (password.trim()) payload.password = password;
      setResult(await post(`/auth/resets/${token}`, payload));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Complete Reset / Activation</h2>
      <form onSubmit={submit} className="stack">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="new password (optional)" type="password" />
        <button className="btn" type="submit">Submit</button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && <pre className="codebox">{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}

export function PublicBusinessesPage() {
  const { query, page, setPage, keyword, setKeyword } = usePagedQuery('/businesses');
  const [data, setData] = useState({ count: 0, results: [] });
  const [error, setError] = useState('');

  useEffect(() => {
    get(query).then(setData).catch((err) => setError(err.message));
  }, [query]);

  return (
    <section className="card">
      <h2>Businesses</h2>
      <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="search" />
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((biz) => (
          <li key={biz.id}>
            <Link to={`/businesses/${biz.id}`}>{biz.business_name}</Link>
            <span>{biz.email}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="ghost-btn" onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
        <span>Page {page}</span>
        <button className="ghost-btn" onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </section>
  );
}

export function PublicBusinessDetailPage() {
  const { businessId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get(`/businesses/${businessId}`).then(setData).catch((err) => setError(err.message));
  }, [businessId]);

  return (
    <section className="card">
      <h2>Business Detail</h2>
      {error && <p className="error">{error}</p>}
      {data && <pre className="codebox">{JSON.stringify(data, null, 2)}</pre>}
    </section>
  );
}

export function QuickAvailabilityToggle() {
  const [value, setValue] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setError('');
    try {
      await patch('/users/me/available', { available: value });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="row">
      <label>
        <input type="checkbox" checked={value} onChange={(e) => setValue(e.target.checked)} /> Available
      </label>
      <button className="ghost-btn" onClick={save}>Update</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
