import {
  createTheme,
  darkTheme,
} from '@backstage/theme';
import type { PageTheme } from '@backstage/theme';

// Editorial-warm tokens from mctl-design (dark terracotta default).
// Portal is dark-only for the branded theme; Backstage light/dark remain stock.
const ink = '#0a0b0d';
const ink2 = '#0f1114';
const ink3 = '#15181d';
const fg = '#e6e7e9';
const terracotta = '#e25a3c';
const terracottaHighlight = '#ff8a6a';
const terracottaGlowStrong = 'rgba(226, 90, 60, 0.5)';
const terracottaGlowSoft = 'rgba(226, 90, 60, 0.1)';
const terracottaLine = 'rgba(226, 90, 60, 0.2)';
const terracottaLineMuted = 'rgba(226, 90, 60, 0.12)';
const terracottaLineFaint = 'rgba(226, 90, 60, 0.08)';
const terracottaLineHover = 'rgba(226, 90, 60, 0.3)';
const ok = '#7cf2a4';
const warn = '#f5a524';
const bad = '#ff6b6b';

const displayFont = '"Onest", system-ui, -apple-system, sans-serif';

const solidPageTheme: PageTheme = {
  colors: [ink2, ink2],
  shape: '',
  backgroundImage: `linear-gradient(180deg, ${ink2} 0%, ${ink2} 100%)`,
  fontColor: fg,
};

const themeOptions = {
  palette: {
    ...darkTheme.palette,
    primary: {
      main: terracotta,
    },
    secondary: {
      main: terracotta,
    },
    error: {
      main: bad,
    },
    warning: {
      main: warn,
    },
    info: {
      main: terracotta,
    },
    success: {
      main: ok,
    },
    background: {
      default: ink,
      paper: ink3,
    },
    banner: {
      info: terracotta,
      error: bad,
      text: ink,
      link: terracottaHighlight,
    },
    errorBackground: bad,
    warningBackground: warn,
    infoBackground: terracotta,
    navigation: {
      background: ink,
      indicator: terracotta,
      color: fg,
      selectedColor: terracottaHighlight,
    },
  },
  defaultPageTheme: 'home',
  fontFamily: displayFont,
  pageTheme: {
    home: solidPageTheme,
    documentation: solidPageTheme,
    tool: solidPageTheme,
    service: solidPageTheme,
    website: solidPageTheme,
    library: solidPageTheme,
    other: solidPageTheme,
    app: solidPageTheme,
    apis: solidPageTheme,
  },
  overrides: {
    MuiCard: {
      root: {
        borderRadius: '16px',
        border: `1px solid ${terracottaLine}`,
        backgroundColor: ink3,
        backgroundImage: 'none',
        boxShadow: 'none',
        transition: 'all 0.3s ease',
        '&:hover': {
          borderColor: terracotta,
          transform: 'translateY(-4px)',
          boxShadow: `0 20px 40px rgba(0,0,0,0.4), 0 0 20px ${terracottaGlowSoft}`,
        },
      },
    },
    MuiCardHeader: {
      root: {
        borderBottom: `1px solid ${terracottaLine}`,
      },
      title: {
        fontWeight: 700,
        color: fg,
      },
    },
    MuiButton: {
      root: {
        borderRadius: '6px',
        textTransform: 'none',
        fontWeight: 600,
        fontFamily: displayFont,
      },
      containedPrimary: {
        backgroundColor: terracotta,
        color: ink,
        '&:hover': {
          backgroundColor: terracottaHighlight,
          boxShadow: `0 0 20px ${terracottaGlowStrong}`,
        },
      },
      outlined: {
        borderColor: terracotta,
        color: terracotta,
      },
    },
    MuiOutlinedInput: {
      root: {
        borderRadius: '6px',
        '& fieldset': {
          borderColor: terracottaLineHover,
        },
        '&:hover fieldset': {
          borderColor: terracotta,
        },
        '&$focused fieldset': {
          borderColor: terracotta,
          boxShadow: `0 0 0 3px ${terracottaGlowSoft}`,
        },
      },
    },
    BackstageHeader: {
      header: {
        boxShadow: 'unset',
        minHeight: '120px',
        backgroundImage: 'none',
        backgroundColor: ink2,
        borderBottom: `1px solid ${terracottaLineMuted}`,
        display: 'flex',
        alignItems: 'center',
        [darkTheme.breakpoints.down('xs')]: {
          minHeight: 'auto',
          paddingBottom: '24px',
        },
      },
      title: {
        color: fg,
        fontWeight: 800,
        fontSize: '42px',
        fontFamily: displayFont,
        textTransform: 'uppercase',
        letterSpacing: '-0.5px',
      },
      subtitle: {
        color: 'rgba(230, 231, 233, 0.8)',
        fontSize: '14px',
        fontFamily: displayFont,
        opacity: 0.8,
      },
      leftItemsBox: {
        // Inject subtitle for pages that lack one (like CatalogIndexPage)
        '& h1:last-child::after': {
          content: '"All services and components in your platform"',
          display: 'block',
          fontSize: '14px',
          fontWeight: 400,
          color: 'rgba(230, 231, 233, 0.8)',
          marginTop: '4px',
          opacity: 0.8,
          textTransform: 'none',
          fontFamily: displayFont,
          letterSpacing: 'normal',
          [darkTheme.breakpoints.down('xs')]: {
            display: 'none',
          },
        },
      },
    },
    BackstageItemCardHeader: {
      root: {
        background: ink2,
        backgroundImage: 'none',
        borderBottom: `1px solid ${terracottaLineFaint}`,
      },
    },
    BackstageSidebar: {
      drawer: {
        backgroundImage: 'unset',
        borderRight: `1px solid ${terracottaLine}`,
      },
    },
  },
};

export const mctlTheme = createTheme(themeOptions);
