import { makeStyles } from '@material-ui/core';

const useStyles = makeStyles({
  root: {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '1.5rem',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '2px',
    display: 'flex',
    alignItems: 'center',
    textDecoration: 'none',
  },
  m: {
    color: '#00f5ff',
    marginRight: '2px',
  },
});

const LogoFull = () => {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      <span className={classes.m}>M</span>CTL
    </div>
  );
};

export default LogoFull;
