import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  CircularProgress,
  Divider,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Tooltip,
  Typography,
} from '@material-ui/core';
import FileCopyIcon from '@material-ui/icons/FileCopy';
import VisibilityIcon from '@material-ui/icons/Visibility';
import VisibilityOffIcon from '@material-ui/icons/VisibilityOff';
import { makeStyles } from '@material-ui/core/styles';
import {
  useEntity,
  MissingAnnotationEmptyState,
} from '@backstage/plugin-catalog-react';
import { Entity } from '@backstage/catalog-model';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

const DB_ANNOTATION = 'platform.mctl.me/database';
const DB_TEAM_ANNOTATION = 'platform.mctl.me/database-team';
const DB_APP_ANNOTATION = 'platform.mctl.me/database-app';

export const hasDatabase = (entity: Entity): boolean =>
  entity?.metadata?.annotations?.[DB_ANNOTATION] === 'true';

const FIELD_LABELS: Record<string, string> = {
  host: 'Host',
  port: 'Port',
  database: 'Database',
  username: 'Username',
  password: 'Password',
};

const useStyles = makeStyles(theme => ({
  fieldLabel: {
    fontWeight: 600,
    width: 120,
    color: theme.palette.text.secondary,
  },
  maskedValue: {
    fontFamily: '"JetBrains Mono", monospace',
    letterSpacing: 2,
  },
  revealedValue: {
    fontFamily: '"JetBrains Mono", monospace',
    wordBreak: 'break-all',
  },
  actions: {
    display: 'flex',
    gap: theme.spacing(0.5),
  },
  loadBtn: {
    marginTop: theme.spacing(2),
  },
  copied: {
    color: theme.palette.success.main,
  },
}));

type Credentials = {
  host: string;
  port: string;
  database: string;
  username: string;
  hasPassword: boolean;
};

const NON_SECRET_FIELDS = ['host', 'port', 'database', 'username'] as const;

function MaskedField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const classes = useStyles();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <TableRow>
      <TableCell className={classes.fieldLabel}>{label}</TableCell>
      <TableCell>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <span className={revealed ? classes.revealedValue : classes.maskedValue}>
            {revealed ? value : '••••••••'}
          </span>
          <span className={classes.actions}>
            <Tooltip title={revealed ? 'Hide' : 'Reveal'}>
              <IconButton size="small" onClick={() => setRevealed(r => !r)}>
                {revealed ? (
                  <VisibilityOffIcon fontSize="small" />
                ) : (
                  <VisibilityIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
            <Tooltip title={copied ? 'Copied!' : 'Copy'}>
              <IconButton
                size="small"
                onClick={handleCopy}
                className={copied ? classes.copied : undefined}
              >
                <FileCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </span>
        </Box>
      </TableCell>
    </TableRow>
  );
}

function PasswordField({
  hasPassword,
  fetchPassword,
}: {
  hasPassword: boolean;
  fetchPassword: () => Promise<{ ok: true; password: string } | { ok: false; error: string }>;
}) {
  const classes = useStyles();
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleHide = () => {
    setRevealed(false);
    // Clear the plaintext from state, not just the display, so it doesn't
    // linger in memory after hiding.
    setPassword(null);
    setError(null);
  };

  const handleReveal = async () => {
    if (!hasPassword) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPassword();
      if (result.ok) {
        setPassword(result.password);
        setRevealed(true);
      } else {
        setError(result.error);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!password) return;
    navigator.clipboard.writeText(password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const displayValue = revealed && password !== null ? password : '••••••••';

  return (
    <TableRow>
      <TableCell className={classes.fieldLabel}>{FIELD_LABELS.password}</TableCell>
      <TableCell>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <span className={revealed ? classes.revealedValue : classes.maskedValue}>
            {loading ? '…' : displayValue}
          </span>
          <span className={classes.actions}>
            <Tooltip title={revealed ? 'Hide' : 'Reveal'}>
              <IconButton
                size="small"
                disabled={loading || !hasPassword}
                onClick={revealed ? handleHide : handleReveal}
              >
                {revealed ? (
                  <VisibilityOffIcon fontSize="small" />
                ) : (
                  <VisibilityIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
            <Tooltip title={copied ? 'Copied!' : 'Copy'}>
              <IconButton
                size="small"
                disabled={!revealed || password === null}
                onClick={handleCopy}
                className={copied ? classes.copied : undefined}
              >
                <FileCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </span>
        </Box>
        {error && (
          <Typography variant="body2" color="error" style={{ marginTop: 4 }}>
            {error}
          </Typography>
        )}
      </TableCell>
    </TableRow>
  );
}

export function EntityDatabaseCard() {
  const classes = useStyles();
  const { entity } = useEntity();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const [loading, setLoading] = useState(false);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);

  const annotations = entity.metadata.annotations ?? {};
  const hasDb = annotations[DB_ANNOTATION] === 'true';

  if (!hasDb) {
    return <MissingAnnotationEmptyState annotation={DB_ANNOTATION} />;
  }

  const team = annotations[DB_TEAM_ANNOTATION];
  const app = annotations[DB_APP_ANNOTATION];

  const handleLoad = async () => {
    setLoading(true);
    setError(null);

    try {
      const baseUrl = await discoveryApi.getBaseUrl('vault-secrets');
      const resp = await fetchApi.fetch(
        `${baseUrl}/teams/${team}/${app}/database`,
      );

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as any;
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }

      setCreds(await resp.json() as Credentials);
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const fetchPassword = async (): Promise<
    { ok: true; password: string } | { ok: false; error: string }
  > => {
    try {
      const baseUrl = await discoveryApi.getBaseUrl('vault-secrets');
      const resp = await fetchApi.fetch(
        `${baseUrl}/teams/${team}/${app}/database/reveal`,
      );
      if (!resp.ok) {
        if (resp.status === 403) {
          return { ok: false, error: 'Developer or owner role required to reveal this value' };
        }
        const body = await resp.json().catch(() => ({})) as any;
        return { ok: false, error: body.error ?? `HTTP ${resp.status}` };
      }
      const body = await resp.json() as { password: string };
      return { ok: true, password: body.password };
    } catch (e: any) {
      return { ok: false, error: e.message ?? 'Unknown error' };
    }
  };

  return (
    <Card>
      <CardHeader title="Database Credentials" />
      <Divider />
      <CardContent>
        {!creds && !loading && (
          <>
            <Typography variant="body2" color="textSecondary">
              Credentials are stored securely in Vault. Click to load (team members only).
            </Typography>
            <Button
              variant="outlined"
              size="small"
              className={classes.loadBtn}
              onClick={handleLoad}
              disabled={!team || !app}
            >
              Load Credentials
            </Button>
            {error && (
              <Typography variant="body2" color="error" style={{ marginTop: 8 }}>
                {error}
              </Typography>
            )}
          </>
        )}

        {loading && (
          <Box display="flex" alignItems="center" style={{ gap: 8 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" style={{ marginLeft: 8 }}>
              Loading…
            </Typography>
          </Box>
        )}

        {creds && (
          <Table size="small">
            <TableBody>
              {NON_SECRET_FIELDS.map(field => (
                <MaskedField
                  key={field}
                  label={FIELD_LABELS[field]}
                  value={creds[field]}
                />
              ))}
              <PasswordField
                hasPassword={creds.hasPassword}
                fetchPassword={fetchPassword}
              />
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
