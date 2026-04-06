import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider } from './contexts/AuthContext';
import {
  LandingPage,
  LoginPage,
  PasswordResetCompletePage,
  PasswordResetRequestPage,
  PublicBusinessDetailPage,
  PublicBusinessesPage,
  RegisterBusinessPage,
  RegisterRegularPage,
} from './pages/PublicPages';
import {
  RegularInterestsPage,
  RegularInvitationsPage,
  RegularJobDetailPage,
  RegularJobsPage,
  RegularNegotiationPage,
  RegularPositionTypesPage,
  RegularProfileEditPage,
  RegularProfilePage,
} from './pages/RegularPages';
import {
  BusinessCandidateDetailPage,
  BusinessCandidatesPage,
  BusinessJobCreatePage,
  BusinessJobDetailPage,
  BusinessJobInterestsPage,
  BusinessJobsPage,
  BusinessNegotiationPage,
  BusinessProfileEditPage,
  BusinessProfilePage,
} from './pages/BusinessPages';
import {
  AdminBusinessesPage,
  AdminPositionTypesPage,
  AdminQualificationsPage,
  AdminSystemConfigPage,
  AdminUsersPage,
} from './pages/AdminPages';
import './App.css';

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register/regular" element={<RegisterRegularPage />} />
            <Route path="/register/business" element={<RegisterBusinessPage />} />
            <Route path="/password/reset/request" element={<PasswordResetRequestPage />} />
            <Route path="/password/reset/:token" element={<PasswordResetCompletePage />} />
            <Route path="/businesses" element={<PublicBusinessesPage />} />
            <Route path="/businesses/:businessId" element={<PublicBusinessDetailPage />} />

            <Route path="/regular/profile" element={<ProtectedRoute allowedRoles={['regular']}><RegularProfilePage /></ProtectedRoute>} />
            <Route path="/regular/profile/edit" element={<ProtectedRoute allowedRoles={['regular']}><RegularProfileEditPage /></ProtectedRoute>} />
            <Route path="/regular/position-types" element={<ProtectedRoute allowedRoles={['regular']}><RegularPositionTypesPage /></ProtectedRoute>} />
            <Route path="/regular/jobs" element={<ProtectedRoute allowedRoles={['regular']}><RegularJobsPage /></ProtectedRoute>} />
            <Route path="/regular/jobs/:jobId" element={<ProtectedRoute allowedRoles={['regular']}><RegularJobDetailPage /></ProtectedRoute>} />
            <Route path="/regular/invitations" element={<ProtectedRoute allowedRoles={['regular']}><RegularInvitationsPage /></ProtectedRoute>} />
            <Route path="/regular/interests" element={<ProtectedRoute allowedRoles={['regular']}><RegularInterestsPage /></ProtectedRoute>} />
            <Route path="/regular/negotiation" element={<ProtectedRoute allowedRoles={['regular']}><RegularNegotiationPage /></ProtectedRoute>} />

            <Route path="/business/profile" element={<ProtectedRoute allowedRoles={['business']}><BusinessProfilePage /></ProtectedRoute>} />
            <Route path="/business/profile/edit" element={<ProtectedRoute allowedRoles={['business']}><BusinessProfileEditPage /></ProtectedRoute>} />
            <Route path="/business/jobs" element={<ProtectedRoute allowedRoles={['business']}><BusinessJobsPage /></ProtectedRoute>} />
            <Route path="/business/jobs/new" element={<ProtectedRoute allowedRoles={['business']}><BusinessJobCreatePage /></ProtectedRoute>} />
            <Route path="/business/jobs/:jobId" element={<ProtectedRoute allowedRoles={['business']}><BusinessJobDetailPage /></ProtectedRoute>} />
            <Route path="/business/jobs/:jobId/candidates" element={<ProtectedRoute allowedRoles={['business']}><BusinessCandidatesPage /></ProtectedRoute>} />
            <Route path="/business/jobs/:jobId/candidates/:userId" element={<ProtectedRoute allowedRoles={['business']}><BusinessCandidateDetailPage /></ProtectedRoute>} />
            <Route path="/business/jobs/:jobId/interests" element={<ProtectedRoute allowedRoles={['business']}><BusinessJobInterestsPage /></ProtectedRoute>} />
            <Route path="/business/negotiation" element={<ProtectedRoute allowedRoles={['business']}><BusinessNegotiationPage /></ProtectedRoute>} />

            <Route path="/admin/users" element={<ProtectedRoute allowedRoles={['admin']}><AdminUsersPage /></ProtectedRoute>} />
            <Route path="/admin/businesses" element={<ProtectedRoute allowedRoles={['admin']}><AdminBusinessesPage /></ProtectedRoute>} />
            <Route path="/admin/position-types" element={<ProtectedRoute allowedRoles={['admin']}><AdminPositionTypesPage /></ProtectedRoute>} />
            <Route path="/admin/qualifications" element={<ProtectedRoute allowedRoles={['admin']}><AdminQualificationsPage /></ProtectedRoute>} />
            <Route path="/admin/system" element={<ProtectedRoute allowedRoles={['admin']}><AdminSystemConfigPage /></ProtectedRoute>} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
