import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, putForm } from '../api';
import NegotiationPanel from '../components/NegotiationPanel';

export function BusinessProfilePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/businesses/me').then(setData).catch((err) => setError(err.message));
  }, []);

  return (
    <section className="card">
      <h2>Business Profile</h2>
      <Link className="btn" to="/business/profile/edit">Edit Profile</Link>
      {error && <p className="error">{error}</p>}
      {data && <pre className="codebox">{JSON.stringify(data, null, 2)}</pre>}
    </section>
  );
}

export function BusinessProfileEditPage() {
  const [form, setForm] = useState({});
  const [avatarFile, setAvatarFile] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    get('/businesses/me').then((me) => {
      setForm({
        business_name: me.business_name,
        owner_name: me.owner_name,
        phone_number: me.phone_number,
        postal_address: me.postal_address,
        location: me.location,
        avatar: me.avatar,
        biography: me.biography || '',
      });
    }).catch((err) => setError(err.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setError('');
    setDone('');
    try {
      await patch('/businesses/me', form);
      if (avatarFile) {
        await putForm('/businesses/me/avatar', avatarFile);
      }
      setDone('Saved');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Edit Business Profile</h2>
      <form onSubmit={save} className="grid-form">
        <input value={form.business_name || ''} onChange={(e) => setForm((p) => ({ ...p, business_name: e.target.value }))} placeholder="business_name" />
        <input value={form.owner_name || ''} onChange={(e) => setForm((p) => ({ ...p, owner_name: e.target.value }))} placeholder="owner_name" />
        <input value={form.phone_number || ''} onChange={(e) => setForm((p) => ({ ...p, phone_number: e.target.value }))} placeholder="phone_number" />
        <input value={form.postal_address || ''} onChange={(e) => setForm((p) => ({ ...p, postal_address: e.target.value }))} placeholder="postal_address" />
        <input value={form.location?.lon ?? ''} onChange={(e) => setForm((p) => ({ ...p, location: { ...p.location, lon: Number(e.target.value) } }))} placeholder="location.lon" type="number" />
        <input value={form.location?.lat ?? ''} onChange={(e) => setForm((p) => ({ ...p, location: { ...p.location, lat: Number(e.target.value) } }))} placeholder="location.lat" type="number" />
        <input value={form.biography || ''} onChange={(e) => setForm((p) => ({ ...p, biography: e.target.value }))} placeholder="biography" />
        <label>avatar file<input type="file" onChange={(e) => setAvatarFile(e.target.files?.[0] || null)} /></label>
        <button className="btn" type="submit">Save</button>
      </form>
      {error && <p className="error">{error}</p>}
      {done && <p>{done}</p>}
    </section>
  );
}

export function BusinessJobsPage() {
  const [data, setData] = useState({ count: 0, results: [] });
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    get(`/businesses/me/jobs?page=${page}&limit=10`).then(setData).catch((err) => setError(err.message));
  }, [page]);

  return (
    <section className="card">
      <h2>Business Jobs</h2>
      <Link className="btn" to="/business/jobs/new">Create Job</Link>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((job) => (
          <li key={job.id}>
            <Link to={`/business/jobs/${job.id}`}>Job {job.id}</Link>
            <span>{job.status}</span>
            <Link to={`/business/jobs/${job.id}/candidates`}>Candidates</Link>
            <Link to={`/business/jobs/${job.id}/interests`}>Interests</Link>
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

export function BusinessJobCreatePage() {
  const [form, setForm] = useState({
    position_type_id: 1,
    salary_min: 30,
    salary_max: 45,
    start_time: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    end_time: new Date(Date.now() + 2 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString(),
    note: '',
  });
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      const job = await post('/businesses/me/jobs', {
        ...form,
        position_type_id: Number(form.position_type_id),
        salary_min: Number(form.salary_min),
        salary_max: Number(form.salary_max),
      });
      navigate(`/business/jobs/${job.id}`);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Create Job</h2>
      <form className="grid-form" onSubmit={create}>
        {Object.keys(form).map((key) => (
          <input key={key} value={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} placeholder={key} />
        ))}
        <button className="btn" type="submit">Create</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export function BusinessJobDetailPage() {
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({});

  async function refresh() {
    setError('');
    try {
      const details = await get(`/jobs/${jobId}`);
      setJob(details);
      setForm({
        salary_min: details.salary_min,
        salary_max: details.salary_max,
        start_time: details.start_time,
        end_time: details.end_time,
        note: details.note || '',
      });
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, [jobId]);

  async function save() {
    setError('');
    try {
      await patch(`/businesses/me/jobs/${jobId}`, {
        salary_min: Number(form.salary_min),
        salary_max: Number(form.salary_max),
        start_time: form.start_time,
        end_time: form.end_time,
        note: form.note,
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    setError('');
    try {
      await del(`/businesses/me/jobs/${jobId}`);
      setJob(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function noShow() {
    setError('');
    try {
      await patch(`/jobs/${jobId}/no-show`, {});
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Business Job Detail</h2>
      {error && <p className="error">{error}</p>}
      {job && (
        <>
          <div className="grid-form">
            {Object.keys(form).map((key) => (
              <input key={key} value={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} placeholder={key} />
            ))}
          </div>
          <div className="row">
            <button className="btn" onClick={save}>Update Job</button>
            <button className="ghost-btn" onClick={remove}>Delete Job</button>
            <button className="ghost-btn" onClick={noShow}>Mark No-Show</button>
          </div>
          <pre className="codebox">{JSON.stringify(job, null, 2)}</pre>
        </>
      )}
    </section>
  );
}

export function BusinessCandidatesPage() {
  const { jobId } = useParams();
  const [data, setData] = useState({ count: 0, results: [] });
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    get(`/jobs/${jobId}/candidates?page=${page}&limit=10`).then(setData).catch((err) => setError(err.message));
  }, [jobId, page]);

  return (
    <section className="card">
      <h2>Discoverable Candidates for Job {jobId}</h2>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((u) => (
          <li key={u.id}>
            <Link to={`/business/jobs/${jobId}/candidates/${u.id}`}>{u.first_name} {u.last_name}</Link>
            <span>invited: {String(u.invited)}</span>
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

export function BusinessCandidateDetailPage() {
  const { jobId, userId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  async function refresh() {
    setError('');
    try {
      setData(await get(`/jobs/${jobId}/candidates/${userId}`));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, [jobId, userId]);

  async function invite(interested) {
    setError('');
    try {
      await patch(`/jobs/${jobId}/candidates/${userId}/interested`, { interested });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Candidate Detail</h2>
      <div className="row">
        <button className="btn" onClick={() => invite(true)}>Invite</button>
        <button className="ghost-btn" onClick={() => invite(false)}>Withdraw Invite</button>
      </div>
      {error && <p className="error">{error}</p>}
      {data && <pre className="codebox">{JSON.stringify(data, null, 2)}</pre>}
    </section>
  );
}

export function BusinessJobInterestsPage() {
  const { jobId } = useParams();
  const [data, setData] = useState({ count: 0, results: [] });
  const [page, setPage] = useState(1);
  const [interestId, setInterestId] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    get(`/jobs/${jobId}/interests?page=${page}&limit=10`).then(setData).catch((err) => setError(err.message));
  }, [jobId, page]);

  async function startNegotiation() {
    setError('');
    try {
      setResult(await post('/negotiations', { interest_id: Number(interestId) }));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Interests for Job {jobId}</h2>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((entry) => (
          <li key={entry.interest_id}>interest {entry.interest_id} - mutual: {String(entry.mutual)} - {entry.user.first_name} {entry.user.last_name}</li>
        ))}
      </ul>
      <div className="row">
        <input value={interestId} onChange={(e) => setInterestId(e.target.value)} placeholder="interest_id" />
        <button className="btn" onClick={startNegotiation}>Start Negotiation</button>
        <Link className="ghost-btn" to="/business/negotiation">Open Negotiation View</Link>
      </div>
      {result && <pre className="codebox">{JSON.stringify(result, null, 2)}</pre>}
      <div className="row">
        <button className="ghost-btn" onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
        <span>Page {page}</span>
        <button className="ghost-btn" onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </section>
  );
}

export function BusinessNegotiationPage() {
  return <NegotiationPanel />;
}
