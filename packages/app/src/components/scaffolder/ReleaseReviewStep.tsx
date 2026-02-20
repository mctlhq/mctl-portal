import React from 'react';
import Card from '@material-ui/core/Card';
import CardContent from '@material-ui/core/CardContent';
import Typography from '@material-ui/core/Typography';
import Grid from '@material-ui/core/Grid';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Chip from '@material-ui/core/Chip';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableRow from '@material-ui/core/TableRow';
import Link from '@material-ui/core/Link';
import CircularProgress from '@material-ui/core/CircularProgress';
import InfoOutlinedIcon from '@material-ui/icons/InfoOutlined';
import CheckCircleOutlineIcon from '@material-ui/icons/CheckCircleOutline';
import LockIcon from '@material-ui/icons/Lock';
import LanguageIcon from '@material-ui/icons/Language';
import { makeStyles } from '@material-ui/core/styles';

const useStyles = makeStyles(theme => ({
  section: {
    marginBottom: theme.spacing(2),
  },
  sectionTitle: {
    fontWeight: 600,
    marginBottom: theme.spacing(1),
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  },
  table: {
    '& td': {
      borderBottom: 'none',
      padding: theme.spacing(0.5, 1),
    },
    '& td:first-child': {
      color: theme.palette.text.secondary,
      width: '40%',
      fontWeight: 500,
    },
  },
  previewBlock: {
    marginTop: theme.spacing(2),
    padding: theme.spacing(2),
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255,255,255,0.05)'
      : 'rgba(0,0,0,0.03)',
    border: `1px solid ${theme.palette.divider}`,
  },
  previewTitle: {
    fontWeight: 600,
    marginBottom: theme.spacing(1),
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
  },
  previewItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(0.5),
    '& svg': {
      fontSize: '1rem',
      marginTop: 2,
      color: theme.palette.success.main,
    },
  },
  maskedValue: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
    marginTop: theme.spacing(3),
  },
  fallbackTable: {
    '& td': {
      padding: theme.spacing(0.75, 1),
    },
    '& td:first-child': {
      color: theme.palette.text.secondary,
      fontWeight: 500,
      width: '35%',
    },
  },
}));

/** Mask values in KEY=VALUE text, showing only keys */
function maskSecrets(text: string): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        return `${line.substring(0, eqIndex)}=****`;
      }
      return line;
    });
}

/** Count non-empty lines */
function countVars(text: string | undefined): number {
  if (!text) return 0;
  return text.split('\n').filter(l => l.trim()).length;
}

/** Extract repo name from owner/repo */
function repoName(fullRepo: string): string {
  return fullRepo?.split('/').pop() || fullRepo;
}

/** Detect if this is the Release Service template by checking form data fields */
function isReleaseService(formData: Record<string, any>): boolean {
  return 'dockerfileRepo' in formData && 'teamName' in formData;
}

interface ReviewStepProps {
  formData: Record<string, any>;
  handleBack: () => void;
  handleCreate: () => void;
  disableButtons: boolean;
  steps: Array<Record<string, any>>;
  handleReset?: () => void;
}

/** Fallback review for non-release templates */
function GenericReview({ formData }: { formData: Record<string, any> }) {
  const classes = useStyles();
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" gutterBottom>Review</Typography>
        <Table size="small" className={classes.fallbackTable}>
          <TableBody>
            {Object.entries(formData).map(([key, value]) => (
              <TableRow key={key}>
                <TableCell>{key}</TableCell>
                <TableCell>
                  {typeof value === 'string' && value.includes('=')
                    ? '(configured)'
                    : String(value ?? '—')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Section card for the release review */
function ReviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const classes = useStyles();
  return (
    <Card variant="outlined" className={classes.section}>
      <CardContent>
        <Typography variant="subtitle1" className={classes.sectionTitle}>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

export function ReleaseReviewStep(props: ReviewStepProps) {
  const { formData, handleBack, handleCreate, disableButtons } = props;
  const classes = useStyles();

  // Fallback for non-release templates
  if (!isReleaseService(formData)) {
    return (
      <>
        <GenericReview formData={formData} />
        <div className={classes.actions}>
          <Button onClick={handleBack} disabled={disableButtons}>
            Back
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={handleCreate}
            disabled={disableButtons}
          >
            {disableButtons ? <CircularProgress size={20} /> : 'Create'}
          </Button>
        </div>
      </>
    );
  }

  const teamName = typeof formData.teamName === 'string'
    ? formData.teamName.replace(/^group:default\//, '')
    : formData.teamName;
  const repo = formData.dockerfileRepo as string;
  const serviceName = repoName(repo);
  const hasHost = formData.host && (formData.host as string).trim().length > 0;
  const serviceType = hasHost ? 'Web Service' : 'Background Worker';
  const envCount = countVars(formData.envVars as string);
  const secretCount = countVars(formData.secretEnvVars as string);
  const maskedSecrets = maskSecrets(formData.secretEnvVars as string);

  return (
    <>
      <Grid container spacing={2}>
        {/* Service section */}
        <Grid item xs={12} md={6}>
          <ReviewSection title="Service">
            <Table size="small" className={classes.table}>
              <TableBody>
                <TableRow>
                  <TableCell>Team</TableCell>
                  <TableCell>{teamName}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Service Name</TableCell>
                  <TableCell><strong>{serviceName}</strong></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Type</TableCell>
                  <TableCell>
                    <Chip label={serviceType} size="small" variant="outlined" />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </ReviewSection>
        </Grid>

        {/* Source & Build section */}
        <Grid item xs={12} md={6}>
          <ReviewSection title="Source & Build">
            <Table size="small" className={classes.table}>
              <TableBody>
                <TableRow>
                  <TableCell>Repository</TableCell>
                  <TableCell>
                    <Link
                      href={`https://github.com/${repo}`}
                      target="_blank"
                      rel="noopener"
                    >
                      {repo}
                    </Link>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Dockerfile</TableCell>
                  <TableCell>{formData.dockerfilePath || 'Dockerfile'}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Version</TableCell>
                  <TableCell><strong>{formData.gitTag}</strong></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Auth</TableCell>
                  <TableCell>
                    {formData.repoPat ? (
                      <Chip
                        icon={<LockIcon />}
                        label="PAT provided"
                        size="small"
                        variant="outlined"
                      />
                    ) : (
                      'GitHub App'
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </ReviewSection>
        </Grid>

        {/* Networking section */}
        <Grid item xs={12} md={6}>
          <ReviewSection title="Networking">
            <Table size="small" className={classes.table}>
              <TableBody>
                <TableRow>
                  <TableCell>Port</TableCell>
                  <TableCell>{formData.port || 8080}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Host</TableCell>
                  <TableCell>
                    {hasHost ? (
                      <Box display="flex" alignItems="center" gridGap={4}>
                        <LanguageIcon fontSize="small" color="primary" />
                        <Typography variant="body2">
                          https://{formData.host}
                        </Typography>
                      </Box>
                    ) : (
                      <Typography variant="body2" color="textSecondary">
                        No ingress (background worker)
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </ReviewSection>
        </Grid>

        {/* Configuration section */}
        <Grid item xs={12} md={6}>
          <ReviewSection title="Configuration">
            <Table size="small" className={classes.table}>
              <TableBody>
                <TableRow>
                  <TableCell>Environment Variables</TableCell>
                  <TableCell>
                    {envCount > 0 ? `${envCount} variable(s)` : 'None'}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Secure Variables</TableCell>
                  <TableCell>
                    {secretCount > 0 ? (
                      <Box>
                        <Typography variant="body2">
                          {secretCount} secret(s)
                        </Typography>
                        {maskedSecrets.map((line, i) => (
                          <Typography
                            key={i}
                            variant="body2"
                            className={classes.maskedValue}
                          >
                            {line}
                          </Typography>
                        ))}
                      </Box>
                    ) : (
                      'None'
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </ReviewSection>
        </Grid>
      </Grid>

      {/* Preview block */}
      <div className={classes.previewBlock}>
        <Typography variant="subtitle2" className={classes.previewTitle}>
          <InfoOutlinedIcon fontSize="small" />
          This release will:
        </Typography>
        <div className={classes.previewItem}>
          <CheckCircleOutlineIcon />
          <Typography variant="body2">
            Build Docker image from <strong>{repo}@{formData.gitTag}</strong>
          </Typography>
        </div>
        <div className={classes.previewItem}>
          <CheckCircleOutlineIcon />
          <Typography variant="body2">
            Create GitOps configuration for <strong>{teamName}/{serviceName}</strong>
          </Typography>
        </div>
        <div className={classes.previewItem}>
          <CheckCircleOutlineIcon />
          <Typography variant="body2">
            Deploy to the preview cluster via ArgoCD
          </Typography>
        </div>
        {secretCount > 0 && (
          <div className={classes.previewItem}>
            <CheckCircleOutlineIcon />
            <Typography variant="body2">
              Store {secretCount} secret(s) in Vault
            </Typography>
          </div>
        )}
        {hasHost && (
          <div className={classes.previewItem}>
            <CheckCircleOutlineIcon />
            <Typography variant="body2">
              Expose service at <strong>https://{formData.host}</strong>
            </Typography>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className={classes.actions}>
        <Button onClick={handleBack} disabled={disableButtons}>
          Back
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={handleCreate}
          disabled={disableButtons}
          startIcon={disableButtons ? <CircularProgress size={16} /> : undefined}
        >
          Release Service
        </Button>
      </div>
    </>
  );
}
