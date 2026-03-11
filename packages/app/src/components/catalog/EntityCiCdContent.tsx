import React from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  Grid,
  Typography,
  Link,
  Chip,
  Box,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import DashboardIcon from '@material-ui/icons/Dashboard';
import GitHubIcon from '@material-ui/icons/GitHub';
import CodeIcon from '@material-ui/icons/Code';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import { useEntity } from '@backstage/plugin-catalog-react';
import { usePlatformConfig } from '../../platformConfig';

const useStyles = makeStyles(theme => ({
  linkCard: {
    display: 'flex',
    alignItems: 'center',
    padding: theme.spacing(2),
    borderRadius: theme.shape.borderRadius,
    border: `1px solid ${theme.palette.divider}`,
    textDecoration: 'none',
    color: theme.palette.text.primary,
    transition: 'background-color 0.15s',
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
      textDecoration: 'none',
    },
  },
  icon: {
    marginRight: theme.spacing(2),
    color: theme.palette.primary.main,
    fontSize: 32,
  },
  externalIcon: {
    marginLeft: 'auto',
    color: theme.palette.text.secondary,
    fontSize: 18,
  },
}));

function CiCdLinkCard({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  const classes = useStyles();
  return (
    <Link href={href} target="_blank" rel="noopener" className={classes.linkCard}>
      <Box className={classes.icon}>{icon}</Box>
      <Box>
        <Typography variant="subtitle1">{title}</Typography>
        <Typography variant="body2" color="textSecondary">
          {description}
        </Typography>
      </Box>
      <OpenInNewIcon className={classes.externalIcon} />
    </Link>
  );
}

export function EntityCiCdContent() {
  const { entity } = useEntity();
  const { argocdBaseUrl, githubOrg, gitopsRepo } = usePlatformConfig();
  const argoApp = entity.metadata.annotations?.['argocd/app-name'] || '';
  const sourceRepo = entity.metadata.annotations?.['github.com/source-repo'] || '';
  const team = (entity.metadata.labels as Record<string, string>)?.team || '';
  const name = entity.metadata.name;

  const argoUrl = argoApp
    ? `${argocdBaseUrl}/${argoApp}`
    : '';
  const actionsUrl = `https://github.com/${githubOrg}/${gitopsRepo}/actions/workflows/release-service.yml`;
  const sourceUrl = sourceRepo ? `https://github.com/${sourceRepo}` : '';

  return (
    <Grid container spacing={3}>
      <Grid item xs={12}>
        <Card>
          <CardHeader
            title="Deployment & CI/CD"
            subheader={
              <Box style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Chip label={`team: ${team}`} size="small" variant="outlined" />
                <Chip label={`service: ${name}`} size="small" variant="outlined" />
              </Box>
            }
          />
          <CardContent>
            <Grid container spacing={2}>
              {argoUrl && (
                <Grid item xs={12} md={4}>
                  <CiCdLinkCard
                    href={argoUrl}
                    icon={<DashboardIcon fontSize="inherit" />}
                    title="ArgoCD Application"
                    description="Sync status, health, and deployment history"
                  />
                </Grid>
              )}
              <Grid item xs={12} md={4}>
                <CiCdLinkCard
                  href={actionsUrl}
                  icon={<GitHubIcon fontSize="inherit" />}
                  title="GitHub Actions"
                  description="Workflow runs for build, deploy, and config updates"
                />
              </Grid>
              {sourceUrl && (
                <Grid item xs={12} md={4}>
                  <CiCdLinkCard
                    href={sourceUrl}
                    icon={<CodeIcon fontSize="inherit" />}
                    title="Source Repository"
                    description="Application source code and Dockerfile"
                  />
                </Grid>
              )}
            </Grid>
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}
