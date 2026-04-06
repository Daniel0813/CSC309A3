import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../api';

export function AdminUsersPage() {
  const [data, setData] = useState({ count: 0, results: [] });
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      setData(await get(`/users?page=${page}&limit=10`));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, [page]);

  async function setSuspended(userId, suspended) {
    setError('');
    try {
      await patch(`/users/${userId}/suspended`, { suspended });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Admin: Users</h2>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((u) => (
          <li key={u.id}>
            {u.first_name} {u.last_name} ({u.email}) suspended: {String(u.suspended)}
            <button className="ghost-btn" onClick={() => setSuspended(u.id, true)}>Suspend</button>
            <button className="ghost-btn" onClick={() => setSuspended(u.id, false)}>Unsuspend</button>
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

export function AdminBusinessesPage() {
  const [data, setData] = useState({ count: 0, results: [] });
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      setData(await get(`/businesses?page=${page}&limit=10`));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, [page]);

  async function setVerified(id, verified) {
    setError('');
    try {
      await patch(`/businesses/${id}/verified`, { verified });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Admin: Businesses</h2>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((b) => (
          <li key={b.id}>
            {b.business_name} ({b.email}) verified: {String(b.verified)}
            <button className="ghost-btn" onClick={() => setVerified(b.id, true)}>Verify</button>
            <button className="ghost-btn" onClick={() => setVerified(b.id, false)}>Unverify</button>
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

export function AdminPositionTypesPage() {
  const [data, setData] = useState({ count: 0, results: [] });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    try {
      setData(await get('/position-types?page=1&limit=100&hidden=true'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function createType() {
    setError('');
    try {
      await post('/position-types', { name, description, hidden: false });
      setName('');
      setDescription('');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function hideType(id, hidden) {
    setError('');
    try {
      await patch(`/position-types/${id}`, { hidden });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteType(id) {
    setError('');
    try {
      await del(`/position-types/${id}`);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Admin: Position Types</h2>
      <div className="row wrap">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="description" />
        <button className="btn" onClick={createType}>Create</button>
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((t) => (
          <li key={t.id}>
            {t.name} hidden: {String(t.hidden)} qualified: {t.num_qualified}
            <button className="ghost-btn" onClick={() => hideType(t.id, true)}>Hide</button>
            <button className="ghost-btn" onClick={() => hideType(t.id, false)}>Unhide</button>
            <button className="ghost-btn" onClick={() => deleteType(t.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdminQualificationsPage() {
  const [data, setData] = useState({ count: 0, results: [] });
  const [qualificationId, setQualificationId] = useState('');
  const [status, setStatus] = useState('approved');
  const [error, setError] = useState('');

  async function refresh() {
    try {
      setData(await get('/qualifications?page=1&limit=30'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function updateStatus() {
    setError('');
    try {
      await patch(`/qualifications/${qualificationId}`, { status });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Admin: Qualification Review</h2>
      <div className="row">
        <input value={qualificationId} onChange={(e) => setQualificationId(e.target.value)} placeholder="qualification_id" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
        </select>
        <button className="btn" onClick={updateStatus}>Update Status</button>
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((q) => (
          <li key={q.id}>#{q.id} {q.user.first_name} {q.user.last_name} - {q.position_type.name} - {q.status}</li>
        ))}
      </ul>
    </section>
  );
}

export function AdminSystemConfigPage() {
  const [form, setForm] = useState({
    reset_cooldown: 60,
    negotiation_window: 900,
    job_start_window: 168,
    availability_timeout: 300,
  });
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function apply() {
    setError('');
    setDone('');
    try {
      await patch('/system/reset-cooldown', { reset_cooldown: Number(form.reset_cooldown) });
      await patch('/system/negotiation-window', { negotiation_window: Number(form.negotiation_window) });
      await patch('/system/job-start-window', { job_start_window: Number(form.job_start_window) });
      await patch('/system/availability-timeout', { availability_timeout: Number(form.availability_timeout) });
      setDone('System settings updated');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Admin: System Configuration</h2>
      <div className="grid-form">
        {Object.keys(form).map((key) => (
          <input key={key} value={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} placeholder={key} />
        ))}
      </div>
      <button className="btn" onClick={apply}>Apply</button>
      {error && <p className="error">{error}</p>}
      {done && <p>{done}</p>}
    </section>
  );
}
