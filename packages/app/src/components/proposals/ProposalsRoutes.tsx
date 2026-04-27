import { Route, Routes } from 'react-router-dom';
import { ProposalsListPage } from './ProposalsListPage';
import { ProposalDetailPage } from './ProposalDetailPage';

export const ProposalsRoutes = () => (
  <Routes>
    <Route path="/" element={<ProposalsListPage />} />
    <Route path=":service/:slug" element={<ProposalDetailPage />} />
  </Routes>
);
