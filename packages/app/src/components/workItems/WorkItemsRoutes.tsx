import { useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { Button, TextField } from '@material-ui/core';
import { Content, Header, Page } from '@backstage/core-components';
import { WorkItemDetailPage } from './WorkItemDetailPage';

const OpenById = () => {
  const [id, setId] = useState('');
  const navigate = useNavigate();
  return (
    <Page themeId="tool">
      <Header title="Work items" subtitle="Open a work item by ID" />
      <Content>
        <TextField
          id="work-item-id"
          label="Work item ID (wi_...)"
          value={id}
          onChange={e => setId(e.target.value)}
        />
        <Button
          color="primary"
          variant="contained"
          disabled={!id.trim()}
          onClick={() => navigate(encodeURIComponent(id.trim()))}
        >
          Open
        </Button>
      </Content>
    </Page>
  );
};

export const WorkItemsRoutes = () => (
  <Routes>
    <Route path="/" element={<OpenById />} />
    <Route path=":workItemId" element={<WorkItemDetailPage />} />
  </Routes>
);
