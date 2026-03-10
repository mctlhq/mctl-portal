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
  password: string;
};

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
              {(Object.keys(FIELD_LABELS) as Array<keyof Credentials>).map(
                field => (
                  <MaskedField
                    key={field}
                    label={FIELD_LABELS[field]}
                    value={creds[field]}
                  />
                ),
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
