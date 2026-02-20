import React from 'react';
import Typography from '@material-ui/core/Typography';
import Card from '@material-ui/core/Card';
import CardContent from '@material-ui/core/CardContent';
import CardActionArea from '@material-ui/core/CardActionArea';
import Grid from '@material-ui/core/Grid';
import Box from '@material-ui/core/Box';
import Divider from '@material-ui/core/Divider';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableRow from '@material-ui/core/TableRow';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import { makeStyles } from '@material-ui/core/styles';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(2, 0),
  },
  successBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    marginBottom: theme.spacing(3),
  },
  successIcon: {
    fontSize: '2.5rem',
    color: theme.palette.success.main,
  },
  summaryTable: {
    '& td': {
      borderBottom: 'none',
      padding: theme.spacing(0.5, 1),
    },
    '& td:first-child': {
      color: theme.palette.text.secondary,
      fontWeight: 500,
      width: '40%',
    },
  },
  linkCard: {
    height: '100%',
    transition: 'box-shadow 0.2s',
    '&:hover': {
      boxShadow: theme.shadows[4],
    },
  },
  linkTitle: {
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
  },
  nextSteps: {
    marginTop: theme.spacing(3),
    padding: theme.spacing(2),
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255,255,255,0.05)'
      : 'rgba(0,0,0,0.03)',
    border: `1px solid ${theme.palette.divider}`,
  },
  stepItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(0.75),
  },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.75rem',
    fontWeight: 700,
    flexShrink: 0,
  },
}));

interface OutputLink {
  title?: string;
  icon?: string;
  url?: string;
}

interface OutputText {
  title?: string;
  content?: string;
}

interface TemplateOutputProps {
  output?: {
    text?: OutputText[];
    links?: OutputLink[];
  };
}

/** Map icon names to link descriptions */
function getLinkDescription(title: string): string {
  const map: Record<string, string> = {
    'Release Pipeline': 'Monitor the build and deployment progress',
    'ArgoCD Dashboard': 'View Kubernetes deployment and sync status',
    'Service Logs': 'View runtime logs via Grafana/Loki',
  };
  return map[title] || 'Open in a new tab';
}

export function ReleaseOutputs({ output }: TemplateOutputProps) {
  const classes = useStyles();

  // Fallback for non-release templates or missing output
  if (!output?.text?.length && !output?.links?.length) {
    return (
      <Box className={classes.root}>
        <div className={classes.successBanner}>
          <CheckCircleIcon className={classes.successIcon} />
          <Box>
            <Typography variant="h5">Task completed</Typography>
            <Typography variant="body2" color="textSecondary">
              The scaffolder task has finished successfully.
            </Typography>
          </Box>
        </div>
      </Box>
    );
  }

  const texts = output?.text || [];
  const links = output?.links || [];

  return (
    <Box className={classes.root}>
      {/* Success banner */}
      <div className={classes.successBanner}>
        <CheckCircleIcon className={classes.successIcon} />
        <Box>
          <Typography variant="h5">Service Release Initiated</Typography>
          <Typography variant="body2" color="textSecondary">
            Your service is being built and deployed to the preview cluster.
          </Typography>
        </Box>
      </div>

      {/* Summary card */}
      {texts.length > 0 && (
        <Card variant="outlined" style={{ marginBottom: 16 }}>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom style={{ fontWeight: 600 }}>
              Release Summary
            </Typography>
            <Table size="small" className={classes.summaryTable}>
              <TableBody>
                {texts.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell>{item.title}</TableCell>
                    <TableCell>{item.content}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Action links */}
      {links.length > 0 && (
        <Grid container spacing={2}>
          {links.map((link, i) => (
            <Grid item xs={12} sm={6} md={4} key={i}>
              <Card variant="outlined" className={classes.linkCard}>
                <CardActionArea
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ height: '100%', padding: 16 }}
                >
                  <Typography className={classes.linkTitle}>
                    {link.title}
                    <OpenInNewIcon fontSize="small" color="action" />
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    {getLinkDescription(link.title || '')}
                  </Typography>
                </CardActionArea>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      {/* What happens next */}
      <div className={classes.nextSteps}>
        <Typography variant="subtitle2" gutterBottom style={{ fontWeight: 600 }}>
          What happens next?
        </Typography>
        <div className={classes.stepItem}>
          <div className={classes.stepNumber}>1</div>
          <Typography variant="body2">
            GitHub Actions builds the Docker image from your repository
          </Typography>
        </div>
        <div className={classes.stepItem}>
          <div className={classes.stepNumber}>2</div>
          <Typography variant="body2">
            GitOps configuration is committed to the platform repository
          </Typography>
        </div>
        <div className={classes.stepItem}>
          <div className={classes.stepNumber}>3</div>
          <Typography variant="body2">
            ArgoCD detects the change and deploys to the preview cluster
          </Typography>
        </div>
        <div className={classes.stepItem}>
          <div className={classes.stepNumber}>4</div>
          <Typography variant="body2">
            Your service becomes available within a few minutes
          </Typography>
        </div>
      </div>
    </Box>
  );
}
