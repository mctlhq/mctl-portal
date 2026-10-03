import { fireEvent, screen } from '@testing-library/react';
import { renderInTestApp } from '@backstage/test-utils';
import { Route, Routes, useLocation, useParams } from 'react-router-dom';
import { WorkItemsRoutes } from './WorkItemsRoutes';

jest.mock('./WorkItemDetailPage', () => ({
  WorkItemDetailPage: () => {
    const { workItemId } = useParams();
    return <div data-testid="detail">{workItemId}</div>;
  },
}));

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

describe('WorkItemsRoutes', () => {
  it('opens a work item by id under the mount point, not at the app root', async () => {
    await renderInTestApp(
      <>
        <Routes>
          <Route path="/work-items/*" element={<WorkItemsRoutes />} />
        </Routes>
        <Where />
      </>,
      { routeEntries: ['/work-items'] },
    );
    fireEvent.change(screen.getByLabelText('Work item ID (wi_...)'), { target: { value: ' wi_123 ' } });
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByTestId('where').textContent).toBe('/work-items/wi_123');
    expect(screen.getByTestId('detail').textContent).toBe('wi_123');
  });
});
