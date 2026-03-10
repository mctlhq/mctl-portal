import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@material-ui/core';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import DeleteIcon from '@material-ui/icons/Delete';
import ErrorIcon from '@material-ui/icons/Error';
import PersonAddIcon from '@material-ui/icons/PersonAdd';
import RefreshIcon from '@material-ui/icons/Refresh';
import { makeStyles } from '@material-ui/core/styles';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
  identityApiRef,
} from '@backstage/core-plugin-api';
import { useIsAdmin } from '../../hooks/useIsAdmin';

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = 'owner' | 'developer' | 'viewer';

interface TenantMember {
  tenantName: string;
  userId: string;
  role: Role;
  invitedAt: string;
  invitedBy: string;
}

interface GithubUserPreview {
  exists: boolean | null; // null = API unavailable
  login?: string;
  name?: string | null;
  avatarUrl?: string;
  error?: string;
}

// ─── Guard ────────────────────────────────────────────────────────────────────

export const isTenantResource = (entity: any): boolean =>
  entity?.kind === 'Resource' &&
  Boolean(entity?.metadata?.annotations?.['mctl.me/tenant-name']);

// ─── Styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles(theme => ({
  tableHead: {
    backgroundColor: theme.palette.background.default,
  },
  roleChip: {
    fontSize: '0.7rem',
    height: 20,
  },
  ownerChip: {
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
  },
  developerChip: {
    backgroundColor: theme.palette.success?.main ?? '#4caf50',
    color: '#fff',
  },
  viewerChip: {
    backgroundColor: theme.palette.grey[500],
    color: '#fff',
  },
  inviteRow: {
    display: 'flex',
    gap: theme.spacing(1),
    alignItems: 'flex-start',
    marginTop: theme.spacing(2),
    flexWrap: 'wrap',
  },
  usernameInput: {
    flexGrow: 1,
    minWidth: 180,
  },
  roleSelect: {
    minWidth: 120,
  },
  emptyState: {
    padding: theme.spacing(4),
    textAlign: 'center',
    color: theme.palette.text.secondary,
  },
  argoLink: {
    fontSize: '0.85rem',
    color: theme.palette.primary.main,
    textDecoration: 'none',
    '&:hover': { textDecoration: 'underline' },
  },
  userPreview: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 1),
    borderRadius: theme.shape.borderRadius,
    border: `1px solid ${theme.palette.success?.main ?? '#4caf50'}`,
    marginTop: theme.spacing(1),
  },
  userPreviewError: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(0.5),
    color: theme.palette.error.main,
    fontSize: '0.8rem',
  },
}));

// ─── Role chip helper ─────────────────────────────────────────────────────────

const RoleChip = ({ role }: { role: Role }) => {
  const classes = useStyles();
  const chipClass =
    role === 'owner'
      ? classes.ownerChip
      : role === 'developer'
      ? classes.developerChip
      : classes.viewerChip;
  return (
    <Chip
      label={role}
      size="small"
      className={`${classes.roleChip} ${chipClass}`}
    />
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

export const TeamManagementCard = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const discoveryApi = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const identityApi = useApi(identityApiRef);

  const isAdmin = useIsAdmin();

  const tenantName = entity?.metadata?.annotations?.['mctl.me/tenant-name'] ?? entity?.metadata?.name ?? '';

  const [members, setMembers] = useState<TenantMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | undefined>();
  const [currentRole, setCurrentRole] = useState<Role | null>(null);

  // Invite form state
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('developer');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // GitHub user lookup state
  const [userPreview, setUserPreview] = useState<GithubUserPreview | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load current user identity
  useEffect(() => {
    identityApi.getBackstageIdentity().then(identity => {
      const username = identity.userEntityRef.split('/').pop();
      setCurrentUserId(username);
    }).catch(() => {});
  }, [identityApi]);

  const loadMembers = useCallback(async () => {
    if (!tenantName) return;
    setLoading(true);
    setError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
      const resp = await fetch(`${baseUrl}/tenants/${tenantName}/members`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setMembers(data.members ?? []);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load team members');
    } finally {
      setLoading(false);
    }
  }, [tenantName, discoveryApi, fetch]);

  // Determine current user's role after members load
  useEffect(() => {
    if (currentUserId && members.length > 0) {
      const me = members.find(m => m.userId === currentUserId);
      setCurrentRole(me?.role ?? null);
    }
  }, [currentUserId, members]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  // Debounced GitHub user lookup
  const lookupUser = useCallback(async (username: string) => {
    if (!username.trim()) {
      setUserPreview(null);
      return;
    }
    setLookingUp(true);
    setUserPreview(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
      const resp = await fetch(`${baseUrl}/check-user?username=${encodeURIComponent(username.trim().toLowerCase())}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: GithubUserPreview = await resp.json();
      setUserPreview(data);
    } catch {
      setUserPreview({ exists: null, error: 'Could not reach GitHub API' });
    } finally {
      setLookingUp(false);
    }
  }, [discoveryApi, fetch]);

  const handleUsernameChange = (value: string) => {
    setInviteUsername(value);
    setInviteError(null);
    setUserPreview(null);

    if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
    const trimmed = value.trim();
    if (trimmed.length >= 1) {
      lookupTimerRef.current = setTimeout(() => lookupUser(trimmed), 400);
    }
  };

  const canManage = currentRole === 'owner' || isAdmin;

  // Invite button is enabled when: username entered AND (user confirmed exists OR API unavailable)
  const canInvite = !inviting && inviteUsername.trim().length > 0 &&
    !lookingUp &&
    (userPreview === null || userPreview.exists === true || userPreview.exists === null);

  const handleInvite = async () => {
    const username = inviteUsername.trim().toLowerCase();
    if (!username) return;
    setInviting(true);
    setInviteError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
      const resp = await fetch(`${baseUrl}/tenants/${tenantName}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: username, role: inviteRole }),
      });
      if (!resp.ok) {
        const body = await resp.json();
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      setInviteUsername('');
      setUserPreview(null);
      await loadMembers();
    } catch (err: any) {
      setInviteError(err.message ?? 'Failed to invite user');
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (userId: string) => {
    if (!window.confirm(`Remove ${userId} from this team?`)) return;
    try {
      const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
      const resp = await fetch(
        `${baseUrl}/tenants/${tenantName}/members/${userId}`,
        { method: 'DELETE' },
      );
      if (!resp.ok) {
        const body = await resp.json();
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      await loadMembers();
    } catch (err: any) {
      setError(err.message ?? 'Failed to remove member');
    }
  };

  const handleRoleChange = async (userId: string, newRole: Role) => {
    try {
      const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
      const resp = await fetch(
        `${baseUrl}/tenants/${tenantName}/members/${userId}/role`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        },
      );
      if (!resp.ok) {
        const body = await resp.json();
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      await loadMembers();
    } catch (err: any) {
      setError(err.message ?? 'Failed to update role');
    }
  };

  if (!tenantName) {
    return (
      <Card>
        <CardContent>
          <Typography variant="body2" color="textSecondary">
            No tenant annotation found on this entity.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Team Members"
        subheader={
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <Typography variant="body2" color="textSecondary">
              Tenant: <strong>{tenantName}</strong>
              {currentRole && (
                <>
                  {' · '}Your role: <RoleChip role={currentRole} />
                </>
              )}
            </Typography>
            <Box display="flex" alignItems="center" style={{ gap: '8px' }}>
              <a
                href={`https://argocd.mctl.me/applications/argocd/${tenantName}`}
                target="_blank"
                rel="noopener noreferrer"
                className={classes.argoLink}
              >
                View in ArgoCD ↗
              </a>
              <Tooltip title="Refresh">
                <IconButton size="small" onClick={loadMembers} disabled={loading}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        }
      />
      <Divider />
      <CardContent>
        {loading && (
          <Box display="flex" justifyContent="center" py={3}>
            <CircularProgress size={32} />
          </Box>
        )}

        {error && (
          <Typography color="error" variant="body2" gutterBottom>
            {error}
          </Typography>
        )}

        {!loading && !error && members.length === 0 && (
          <Typography variant="body2" className={classes.emptyState}>
            No team members yet.
          </Typography>
        )}

        {!loading && members.length > 0 && (
          <Table size="small">
            <TableHead className={classes.tableHead}>
              <TableRow>
                <TableCell>GitHub Username</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Invited By</TableCell>
                <TableCell>Since</TableCell>
                {canManage && <TableCell align="right">Actions</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map(member => (
                <TableRow key={member.userId}>
                  <TableCell>
                    <Box display="flex" alignItems="center" style={{ gap: '8px' }}>
                      <img
                        src={`https://github.com/${member.userId}.png?size=24`}
                        alt={member.userId}
                        width={24}
                        height={24}
                        style={{ borderRadius: '50%' }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      <a
                        href={`https://github.com/${member.userId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={classes.argoLink}
                      >
                        {member.userId}
                      </a>
                      {member.userId === currentUserId && (
                        <Chip label="you" size="small" className={classes.roleChip} />
                      )}
                    </Box>
                  </TableCell>
                  <TableCell>
                    {canManage && member.userId !== currentUserId ? (
                      <FormControl size="small">
                        <Select
                          value={member.role}
                          onChange={e => handleRoleChange(member.userId, e.target.value as Role)}
                          disableUnderline
                        >
                          <MenuItem value="owner">owner</MenuItem>
                          <MenuItem value="developer">developer</MenuItem>
                          <MenuItem value="viewer">viewer</MenuItem>
                        </Select>
                      </FormControl>
                    ) : (
                      <RoleChip role={member.role} />
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="textSecondary">
                      {member.invitedBy}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="textSecondary">
                      {new Date(member.invitedAt).toLocaleDateString()}
                    </Typography>
                  </TableCell>
                  {canManage && (
                    <TableCell align="right">
                      {member.userId !== currentUserId && (
                        <Tooltip title="Remove from team">
                          <IconButton
                            size="small"
                            onClick={() => handleRemove(member.userId)}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Invite form — owners only */}
        {canManage && (
          <>
            <Divider style={{ marginTop: 16, marginBottom: 8 }} />
            <Typography variant="subtitle2" gutterBottom>
              Invite a new member
            </Typography>
            <Box className={classes.inviteRow}>
              <Box className={classes.usernameInput}>
                <TextField
                  fullWidth
                  size="small"
                  variant="outlined"
                  placeholder="GitHub username"
                  value={inviteUsername}
                  onChange={e => handleUsernameChange(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && canInvite) handleInvite(); }}
                  disabled={inviting}
                  InputProps={{
                    endAdornment: lookingUp ? (
                      <CircularProgress size={16} />
                    ) : userPreview?.exists === true ? (
                      <CheckCircleIcon style={{ color: '#4caf50', fontSize: 18 }} />
                    ) : userPreview?.exists === false ? (
                      <ErrorIcon color="error" style={{ fontSize: 18 }} />
                    ) : null,
                  }}
                />
                {/* User preview */}
                {userPreview?.exists === true && (
                  <Box className={classes.userPreview}>
                    <Avatar
                      src={userPreview.avatarUrl}
                      alt={userPreview.login}
                      style={{ width: 24, height: 24 }}
                    />
                    <Typography variant="body2">
                      <strong>{userPreview.login}</strong>
                      {userPreview.name && (
                        <span style={{ color: 'inherit', opacity: 0.7 }}>{' '}({userPreview.name})</span>
                      )}
                    </Typography>
                    <a
                      href={`https://github.com/${userPreview.login}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={classes.argoLink}
                      style={{ marginLeft: 'auto' }}
                    >
                      GitHub ↗
                    </a>
                  </Box>
                )}
                {userPreview?.exists === false && (
                  <Box className={classes.userPreviewError}>
                    <ErrorIcon style={{ fontSize: 14 }} />
                    <span>GitHub user not found</span>
                  </Box>
                )}
              </Box>
              <FormControl variant="outlined" size="small" className={classes.roleSelect}>
                <Select
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as Role)}
                  disabled={inviting}
                >
                  <MenuItem value="owner">Owner</MenuItem>
                  <MenuItem value="developer">Developer</MenuItem>
                  <MenuItem value="viewer">Viewer</MenuItem>
                </Select>
              </FormControl>
              <Button
                variant="contained"
                color="primary"
                size="small"
                startIcon={inviting ? <CircularProgress size={14} /> : <PersonAddIcon />}
                onClick={handleInvite}
                disabled={!canInvite}
              >
                Invite
              </Button>
            </Box>
            {inviteError && (
              <Typography color="error" variant="body2" style={{ marginTop: 8 }}>
                {inviteError}
              </Typography>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};

