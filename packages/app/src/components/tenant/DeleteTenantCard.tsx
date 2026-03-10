import { useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
  Typography,
  CircularProgress,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import DeleteForeverIcon from '@material-ui/icons/DeleteForever';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import { useEntity } from '@backstage/plugin-catalog-react';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { useNavigate } from 'react-router-dom';
import { useIsAdmin } from '../../hooks/useIsAdmin';

const useStyles = makeStyles(theme => ({
  dangerCard: {
    borderLeft: `4px solid ${theme.palette.error.main}`,
  },
  deleteButton: {
    backgroundColor: theme.palette.error.main,
    color: theme.palette.error.contrastText,
    '&:hover': {
      backgroundColor: theme.palette.error.dark,
    },
  },
  confirmInput: {
    marginTop: theme.spacing(2),
  },
  workflowLink: {
    marginTop: theme.spacing(1),
  },
}));

const PROTECTED_TENANTS = ['admins'];

export const DeleteTenantCard = () => {
  const classes = useStyles();
  const isAdmin = useIsAdmin();
  const { entity } = useEntity();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const navigate = useNavigate();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflowUrl, setWorkflowUrl] = useState<string | null>(null);

  const tenantName =
    entity.metadata.annotations?.['mctl.me/tenant-name'] || '';
  const isProtected = PROTECTED_TENANTS.includes(tenantName);
  const confirmMatch = confirmText === tenantName;

  if (!isAdmin) return null;
  if (!tenantName) return null;

  const handleDelete = async () => {
    setLoading(true);
    setError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
      const resp = await fetchApi.fetch(
        `${baseUrl}/tenants/${encodeURIComponent(tenantName)}`,
        { method: 'DELETE' },
      );
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      setWorkflowUrl(data.workflowUrl || null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setDialogOpen(false);
    setConfirmText('');
    setError(null);
    if (workflowUrl) {
      navigate('/catalog?filters%5Bkind%5D=resource&filters%5Buser%5D=all');
    }
    setWorkflowUrl(null);
  };

  return (
    <>
      <Card className={classes.dangerCard}>
        <CardHeader title="Danger Zone" />
        <CardContent>
          <Typography variant="body2" gutterBottom>
            Permanently delete tenant <strong>{tenantName}</strong> and all
            associated resources (namespace, Vault policies, ArgoCD RBAC, Git
            config).
          </Typography>
          <Button
            variant="contained"
            className={classes.deleteButton}
            startIcon={<DeleteForeverIcon />}
            disabled={isProtected}
            onClick={() => setDialogOpen(true)}
          >
            {isProtected ? 'Protected Tenant' : 'Delete Tenant'}
          </Button>
          {isProtected && (
            <Typography variant="caption" color="textSecondary" display="block">
              This tenant cannot be deleted.
            </Typography>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>Delete Tenant "{tenantName}"</DialogTitle>
        <DialogContent>
          {workflowUrl ? (
            <>
              <DialogContentText>
                Tenant deletion workflow has been submitted successfully.
              </DialogContentText>
              <Button
                variant="outlined"
                color="primary"
                startIcon={<OpenInNewIcon />}
                href={workflowUrl}
                target="_blank"
                className={classes.workflowLink}
              >
                View Workflow
              </Button>
            </>
          ) : (
            <>
              <DialogContentText>
                This action is <strong>irreversible</strong>. It will delete:
              </DialogContentText>
              <ul>
                <li>Kubernetes namespace and all workloads</li>
                <li>Vault secrets and policies</li>
                <li>ArgoCD RBAC rules</li>
                <li>Git configuration</li>
                <li>Database records and team memberships</li>
              </ul>
              <DialogContentText>
                Type <strong>{tenantName}</strong> to confirm:
              </DialogContentText>
              <TextField
                className={classes.confirmInput}
                autoFocus
                fullWidth
                variant="outlined"
                size="small"
                placeholder={tenantName}
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                error={!!error}
                helperText={error}
                disabled={loading}
              />
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={loading}>
            {workflowUrl ? 'Close' : 'Cancel'}
          </Button>
          {!workflowUrl && (
            <Button
              className={classes.deleteButton}
              variant="contained"
              onClick={handleDelete}
              disabled={!confirmMatch || loading}
              startIcon={
                loading ? <CircularProgress size={16} /> : <DeleteForeverIcon />
              }
            >
              Delete
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
};
