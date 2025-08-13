import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import App from './App';

const theme = createTheme({
  palette: {
    primary: {
      main: '#1976d2',
    },
    secondary: {
      main: '#dc004e',
    },
    background: {
      default: '#f5f5f5',
    },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    fontSize: 16, // Increased base font size from 14 to 16
    h1: {
      fontSize: '2.5rem',
      '@media (max-width:600px)': {
        fontSize: '2rem',
      },
    },
    h2: {
      fontSize: '2rem',
      '@media (max-width:600px)': {
        fontSize: '1.75rem',
      },
    },
    h3: {
      fontSize: '1.75rem',
      '@media (max-width:600px)': {
        fontSize: '1.5rem',
      },
    },
    h4: {
      fontSize: '1.5rem',
      '@media (max-width:600px)': {
        fontSize: '1.25rem',
      },
    },
    h5: {
      fontSize: '1.25rem',
      '@media (max-width:600px)': {
        fontSize: '1.125rem',
      },
    },
    h6: {
      fontSize: '1.125rem',
      '@media (max-width:600px)': {
        fontSize: '1rem',
      },
    },
    body1: {
      fontSize: '1rem',
      lineHeight: 1.6,
      '@media (max-width:600px)': {
        fontSize: '0.95rem',
      },
    },
    body2: {
      fontSize: '0.875rem',
      lineHeight: 1.5,
      '@media (max-width:600px)': {
        fontSize: '0.85rem',
      },
    },
    subtitle1: {
      fontSize: '1.125rem',
      fontWeight: 500,
      '@media (max-width:600px)': {
        fontSize: '1.0625rem',
      },
    },
    subtitle2: {
      fontSize: '1rem',
      fontWeight: 500,
      '@media (max-width:600px)': {
        fontSize: '0.9375rem',
      },
    },
  },
  components: {
    // Global CSS baseline for mobile
    MuiCssBaseline: {
      styleOverrides: {
        html: {
          // Prevent zoom on double-tap for iOS
          touchAction: 'manipulation',
        },
        body: {
          // Disable pull-to-refresh on mobile
          overscrollBehavior: 'none',
          // Improve touch scrolling on iOS
          WebkitOverflowScrolling: 'touch',
        },
        // Prevent zoom on input focus for mobile
        '@media (max-width: 600px)': {
          'input[type="text"], input[type="email"], input[type="password"], textarea, select': {
            fontSize: '16px !important',
            WebkitAppearance: 'none',
            borderRadius: 0,
          },
        },
      },
    },
    
    // Mobile-friendly text fields
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiInputBase-input': {
            fontSize: '1rem',
            '@media (max-width:600px)': {
              fontSize: '16px', // Prevent zoom on iOS
            },
          },
        },
      },
    },
    
    // Larger buttons for mobile
    MuiButton: {
      styleOverrides: {
        root: {
          fontSize: '1rem',
          padding: '10px 16px',
          minHeight: '44px', // Apple's recommended minimum touch target
          '@media (max-width:600px)': {
            fontSize: '0.95rem',
            padding: '12px 20px',
            minHeight: '48px',
          },
        },
      },
    },
    
    // Larger icon buttons for mobile
    MuiIconButton: {
      styleOverrides: {
        root: {
          '@media (max-width:600px)': {
            padding: '12px',
            minWidth: '44px',
            minHeight: '44px',
          },
        },
      },
    },
    
    // Mobile-optimized list items
    MuiListItemButton: {
      styleOverrides: {
        root: {
          minHeight: '48px',
          '@media (max-width:600px)': {
            minHeight: '56px',
            paddingTop: '12px',
            paddingBottom: '12px',
          },
        },
      },
    },
    
    // Better list item text sizing
    MuiListItemText: {
      styleOverrides: {
        primary: {
          fontSize: '1.125rem',
          '@media (max-width:600px)': {
            fontSize: '1.0625rem',
          },
        },
        secondary: {
          fontSize: '1rem',
          '@media (max-width:600px)': {
            fontSize: '0.9375rem',
          },
        },
      },
    },
    
    // Mobile-friendly chips
    MuiChip: {
      styleOverrides: {
        root: {
          '@media (max-width:600px)': {
            height: '28px',
            '& .MuiChip-label': {
              fontSize: '0.75rem',
              paddingLeft: '8px',
              paddingRight: '8px',
            },
            '& .MuiChip-icon': {
              fontSize: '16px',
            },
          },
        },
      },
    },
    
    // Mobile-optimized app bar
    MuiAppBar: {
      styleOverrides: {
        root: {
          '@media (max-width:600px)': {
            '& .MuiToolbar-root': {
              minHeight: '64px',
              paddingLeft: '16px',
              paddingRight: '16px',
            },
          },
        },
      },
    },
    
    // Better mobile dialogs
    MuiDialog: {
      styleOverrides: {
        root: {
          '@media (max-width:600px)': {
            '& .MuiDialog-paper': {
              margin: '16px',
              width: 'calc(100% - 32px)',
              maxWidth: 'none',
            },
          },
        },
      },
    },
    
    // Mobile-optimized fab
    MuiFab: {
      styleOverrides: {
        root: {
          '@media (max-width:600px)': {
            width: '64px',
            height: '64px',
          },
        },
      },
    },
    
    // Improve scrollbars for mobile
    MuiPaper: {
      styleOverrides: {
        root: {
          '@media (max-width:600px)': {
            '&::-webkit-scrollbar': {
              width: '6px',
            },
            '&::-webkit-scrollbar-track': {
              backgroundColor: 'transparent',
            },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: 'rgba(0,0,0,0.2)',
              borderRadius: '3px',
            },
          },
        },
      },
    },
  },
  
  // Custom breakpoints for better mobile support
  breakpoints: {
    values: {
      xs: 0,
      sm: 600,
      md: 900,
      lg: 1200,
      xl: 1536,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);