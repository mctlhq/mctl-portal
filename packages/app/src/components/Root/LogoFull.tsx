import { makeStyles } from '@material-ui/core';

const useStyles = makeStyles({
  root: {
    fontFamily: '"Onest", system-ui, -apple-system, sans-serif',
    fontSize: '1.5rem',
    fontWeight: 800,
    color: '#e6e7e9',
    letterSpacing: '2px',
    display: 'flex',
    alignItems: 'center',
    textDecoration: 'none',
  },
  m: {
    color: '#e25a3c',
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
