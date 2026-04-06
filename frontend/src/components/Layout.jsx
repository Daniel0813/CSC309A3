import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

function roleLinks(role) {
  if (role === 'regular') {
    return [
      ['Profile', '/regular/profile'],
      ['Position Types', '/regular/position-types'],
      ['Jobs', '/regular/jobs'],
      ['Invitations', '/regular/invitations'],
      ['Interests', '/regular/interests'],
      ['Negotiation', '/regular/negotiation'],
    ];
  }
  if (role === 'business') {
    return [
      ['Profile', '/business/profile'],
      ['Jobs', '/business/jobs'],
      ['New Job', '/business/jobs/new'],
      ['Negotiation', '/business/negotiation'],
    ];
  }
  if (role === 'admin') {
    return [
      ['Users', '/admin/users'],
      ['Businesses', '/admin/businesses'],
      ['Position Types', '/admin/position-types'],
      ['Qualifications', '/admin/qualifications'],
      ['System Config', '/admin/system'],
    ];
  }
  return [];
}

export default function Layout({ children }) {
  const { role, token, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" to="/">Temping Platform</Link>
        <nav className="topnav">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/businesses">Businesses</NavLink>
          {!token && <NavLink to="/register/regular">Join as Professional</NavLink>}
          {!token && <NavLink to="/register/business">Join as Business</NavLink>}
          {!token && <NavLink to="/login">Login</NavLink>}
          {roleLinks(role).map(([label, path]) => (
            <NavLink key={path} to={path}>{label}</NavLink>
          ))}
          {token && (
            <button
              className="ghost-btn"
              onClick={() => {
                logout();
                navigate('/');
              }}
            >
              Logout
            </button>
          )}
        </nav>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
