import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, patch, post, putForm } from '../api';
import NegotiationPanel from '../components/NegotiationPanel';
import { QuickAvailabilityToggle } from './PublicPages';

function useQuery(base) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [sort, setSort] = useState('start_time');
  const [order, setOrder] = useState('asc');
  const [positionTypeId, setPositionTypeId] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');

  const query = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.set('limit', String(limit));
    if (sort) qs.set('sort', sort);
    if (order) qs.set('order', order);
    if (positionTypeId) qs.set('position_type_id', positionTypeId);
    if (lat) qs.set('lat', lat);
    if (lon) qs.set('lon', lon);
    return `${base}?${qs.toString()}`;
  }, [base, page, limit, sort, order, positionTypeId, lat, lon]);

  return {
    query,
    page,
    setPage,
    setSort,
    setOrder,
    setPositionTypeId,
    lat,
    lon,
    setLat,
    setLon,
  };
}

export function RegularProfilePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/users/me').then(setData).catch((err) => setError(err.message));
  }, []);

  return (
    <section className="card">
      <h2>Regular Profile</h2>
      <QuickAvailabilityToggle />
      <Link className="btn" to="/regular/profile/edit">Edit Profile</Link>
      <Link className="btn" to="/regular/position-types">Manage Qualifications</Link>
      {error && <p className="error">{error}</p>}
      {data && <pre className="codebox">{JSON.stringify(data, null, 2)}</pre>}
    </section>
  );
}

export function RegularProfileEditPage() {
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [avatarFile, setAvatarFile] = useState(null);
  const [resumeFile, setResumeFile] = useState(null);

  useEffect(() => {
    get('/users/me').then((me) => setForm({
      first_name: me.first_name,
      last_name: me.last_name,
      phone_number: me.phone_number,
      postal_address: me.postal_address,
      birthday: me.birthday,
      avatar: me.avatar,
      biography: me.biography || '',
    })).catch((err) => setError(err.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setError('');
    setDone('');
    try {
      await patch('/users/me', form);
      if (avatarFile) {
        await putForm('/users/me/avatar', avatarFile);
      }
      if (resumeFile) {
        await putForm('/users/me/resume', resumeFile);
      }
      setDone('Saved');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Edit Regular Profile</h2>
      <form onSubmit={save} className="grid-form">
        {Object.keys(form).map((key) => (
          <input key={key} value={form[key] ?? ''} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} placeholder={key} />
        ))}
        <label>avatar file<input type="file" onChange={(e) => setAvatarFile(e.target.files?.[0] || null)} /></label>
        <label>resume file<input type="file" onChange={(e) => setResumeFile(e.target.files?.[0] || null)} /></label>
        <button className="btn" type="submit">Save</button>
      </form>
      {error && <p className="error">{error}</p>}
      {done && <p>{done}</p>}
    </section>
  );
}

export function RegularPositionTypesPage() {
  const [types, setTypes] = useState([]);
  const [error, setError] = useState('');
  const [positionTypeId, setPositionTypeId] = useState('');
  const [note, setNote] = useState('');
  const [qualificationId, setQualificationId] = useState('');
  const [documentFile, setDocumentFile] = useState(null);

  async function refresh() {
    try {
      const data = await get('/position-types?page=1&limit=50');
      setTypes(data.results);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createQualification() {
    setError('');
    try {
      await post('/qualifications', { position_type_id: Number(positionTypeId), note });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function uploadQualificationDoc() {
    setError('');
    if (!qualificationId || !documentFile) {
      setError('qualification id and file required');
      return;
    }
    try {
      await putForm(`/qualifications/${qualificationId}/document`, documentFile);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Position Types and Qualification Requests</h2>
      <ul className="list">
        {types.map((t) => (
          <li key={t.id}>{t.name} - {t.description}</li>
        ))}
      </ul>
      <div className="stack">
        <input value={positionTypeId} onChange={(e) => setPositionTypeId(e.target.value)} placeholder="position_type_id" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note" />
        <button className="btn" onClick={createQualification}>Create Qualification</button>
      </div>
      <div className="stack">
        <input value={qualificationId} onChange={(e) => setQualificationId(e.target.value)} placeholder="qualification_id for document upload" />
        <input type="file" onChange={(e) => setDocumentFile(e.target.files?.[0] || null)} />
        <button className="btn" onClick={uploadQualificationDoc}>Upload Qualification Document</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export function RegularJobsPage() {
  const { query, page, setPage, setSort, setOrder, setPositionTypeId, lat, lon, setLat, setLon } = useQuery('/jobs');
  const [data, setData] = useState({ count: 0, results: [] });
  const [error, setError] = useState('');

  useEffect(() => {
    get(query).then(setData).catch((err) => setError(err.message));
  }, [query]);

  return (
    <section className="card">
      <h2>Open Jobs</h2>
      <div className="row wrap">
        <input placeholder="position_type_id" onChange={(e) => setPositionTypeId(e.target.value)} />
        <input placeholder="lat" value={lat} onChange={(e) => setLat(e.target.value)} />
        <input placeholder="lon" value={lon} onChange={(e) => setLon(e.target.value)} />
        <select onChange={(e) => setSort(e.target.value)}>
          <option value="start_time">start_time</option>
          <option value="updatedAt">updatedAt</option>
          <option value="salary_min">salary_min</option>
          <option value="salary_max">salary_max</option>
          <option value="distance">distance</option>
          <option value="eta">eta</option>
        </select>
        <select onChange={(e) => setOrder(e.target.value)}>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((job) => (
          <li key={job.id}>
            <Link to={`/regular/jobs/${job.id}`}>Job {job.id}</Link>
            <span>{job.business.business_name}</span>
            <span>{job.status}</span>
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

export function RegularJobDetailPage() {
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      setJob(await get(`/jobs/${jobId}`));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, [jobId]);

  async function setInterested(interested) {
    setError('');
    try {
      await patch(`/jobs/${jobId}/interested`, { interested });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Job Detail</h2>
      <div className="row">
        <button className="btn" onClick={() => setInterested(true)}>Express Interest</button>
        <button className="ghost-btn" onClick={() => setInterested(false)}>Withdraw Interest</button>
      </div>
      {error && <p className="error">{error}</p>}
      {job && <pre className="codebox">{JSON.stringify(job, null, 2)}</pre>}
    </section>
  );
}

export function RegularInvitationsPage() {
  const [data, setData] = useState({ count: 0, results: [] });
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    get(`/users/me/invitations?page=${page}&limit=10`).then(setData).catch((err) => setError(err.message));
  }, [page]);

  return (
    <section className="card">
      <h2>Invitations</h2>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((job) => (
          <li key={job.id}><Link to={`/regular/jobs/${job.id}`}>Job {job.id}</Link> {job.position_type.name}</li>
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

export function RegularInterestsPage() {
  const [data, setData] = useState({ count: 0, results: [] });
  const [page, setPage] = useState(1);
  const [interestId, setInterestId] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    get(`/users/me/interests?page=${page}&limit=10`).then(setData).catch((err) => setError(err.message));
  }, [page]);

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
      <h2>My Interests</h2>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {data.results.map((entry) => (
          <li key={entry.interest_id}>Interest {entry.interest_id} - mutual: {String(entry.mutual)} - job {entry.job.id}</li>
        ))}
      </ul>
      <div className="row">
        <input value={interestId} onChange={(e) => setInterestId(e.target.value)} placeholder="interest_id" />
        <button className="btn" onClick={startNegotiation}>Start Negotiation</button>
        <Link className="ghost-btn" to="/regular/negotiation">Open Negotiation View</Link>
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

export function RegularNegotiationPage() {
  return <NegotiationPanel />;
}
