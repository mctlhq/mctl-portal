import {
  createTheme,
  darkTheme,
} from '@backstage/theme';
import type { PageTheme } from '@backstage/theme';

const solidPageTheme: PageTheme = {
  colors: ['#0a1d35', '#0a1d35'],
  shape: '',
  backgroundImage: 'linear-gradient(180deg, #0a1d35 0%, #0a1d35 100%)',
  fontColor: '#ffffff',
};

const themeOptions = {
  palette: {
    ...darkTheme.palette,
    primary: {
      main: '#00f5ff',
    },
    secondary: {
      main: '#00f5ff',
    },
    error: {
      main: '#f85149',
    },
    warning: {
      main: '#ff9800',
    },
    info: {
      main: '#00f5ff',
    },
    success: {
      main: '#3fb950',
    },
    background: {
      default: '#050816',
      paper: '#0d111d',
    },
    banner: {
      info: '#00f5ff',
      error: '#f85149',
      text: '#050816',
      link: '#005cc5',
    },
    errorBackground: '#f85149',
    warningBackground: '#ff9800',
    infoBackground: '#00f5ff',
    navigation: {
      background: '#050816',
      indicator: '#00f5ff',
      color: '#e6edf3',
      selectedColor: '#00f5ff',
    },
  },
  defaultPageTheme: 'home',
  fontFamily: '"JetBrains Mono", monospace',
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
        border: '1px solid rgba(0, 245, 255, 0.2)',
        backgroundColor: '#0d111d',
        backgroundImage: 'none',
        boxShadow: 'none',
        transition: 'all 0.3s ease',
        '&:hover': {
          borderColor: '#00f5ff',
          transform: 'translateY(-4px)',
          boxShadow: '0 20px 40px rgba(0,0,0,0.4), 0 0 20px rgba(0,245,255,0.1)',
        },
      },
    },
    MuiCardHeader: {
      root: {
        borderBottom: '1px solid rgba(0, 245, 255, 0.2)',
      },
      title: {
        fontWeight: 700,
        color: '#ffffff',
      },
    },
    MuiButton: {
      root: {
        borderRadius: '6px',
        textTransform: 'none',
        fontWeight: 600,
        fontFamily: '"JetBrains Mono", monospace',
      },
      containedPrimary: {
        backgroundColor: '#00f5ff',
        color: '#050816',
        '&:hover': {
          backgroundColor: '#00f5ff',
          boxShadow: '0 0 20px rgba(0, 245, 255, 0.5)',
        },
      },
      outlined: {
        borderColor: '#00f5ff',
        color: '#00f5ff',
      },
    },
    MuiOutlinedInput: {
      root: {
        borderRadius: '6px',
        '& fieldset': {
          borderColor: 'rgba(0, 245, 255, 0.3)',
        },
        '&:hover fieldset': {
          borderColor: '#00f5ff',
        },
        '&$focused fieldset': {
          borderColor: '#00f5ff',
          boxShadow: '0 0 0 3px rgba(0, 245, 255, 0.1)',
        },
      },
    },
    BackstageHeader: {
      header: {
        boxShadow: 'unset',
        minHeight: '120px',
        backgroundImage: 'none',
        backgroundColor: '#0a1d35',
        borderBottom: '1px solid rgba(0, 245, 255, 0.12)',
        display: 'flex',
        alignItems: 'center',
        [darkTheme.breakpoints.down('xs')]: {
          minHeight: 'auto',
          paddingBottom: '24px',
        },
      },
      title: {
        color: '#ffffff',
        fontWeight: 800,
        fontSize: '42px',
        fontFamily: '"JetBrains Mono", monospace',
        textTransform: 'uppercase',
        letterSpacing: '-0.5px',
      },
      subtitle: {
        color: 'rgba(255, 255, 255, 0.8)',
        fontSize: '14px',
        fontFamily: '"JetBrains Mono", monospace',
        opacity: 0.8,
      },
      leftItemsBox: {
        // Inject subtitle for pages that lack one (like CatalogIndexPage)
        '& h1:last-child::after': {
          content: '"All services and components in your platform"',
          display: 'block',
          fontSize: '14px',
          fontWeight: 400,
          color: 'rgba(255, 255, 255, 0.8)',
          marginTop: '4px',
          opacity: 0.8,
          textTransform: 'none',
          fontFamily: '"JetBrains Mono", monospace',
          letterSpacing: 'normal',
          [darkTheme.breakpoints.down('xs')]: {
            display: 'none',
          },
        },
      },
    },
    BackstageItemCardHeader: {
      root: {
        background: '#0a1d35',
        backgroundImage: 'none',
        borderBottom: '1px solid rgba(0, 245, 255, 0.08)',
      },
    },
    BackstageSidebar: {
      drawer: {
        backgroundImage: 'unset',
        borderRight: '1px solid rgba(0, 245, 255, 0.2)',
      },
    },
  },
};

export const mctlTheme = createTheme(themeOptions);
