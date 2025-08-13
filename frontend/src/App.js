import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { 
  Box, 
  AppBar, 
  Toolbar, 
  Typography, 
  Button, 
  Avatar, 
  Menu, 
  MenuItem, 
  IconButton, 
  Chip,
  Snackbar,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  useTheme,
  useMediaQuery,
  Fab
} from '@mui/material';
import { 
  Add as AddIcon, 
  AccountCircle, 
  GetApp as InstallIcon, 
  Sync as SyncIcon,
  Warning as WarningIcon,
  Wifi as WifiIcon,
  WifiOff as WifiOffIcon
} from '@mui/icons-material';
import Login from './components/Login';
import NoteEditor from './components/NoteEditor';
import NotesList from './components/NotesList';
import OfflineStatus from './components/OfflineStatus';
import api from './utils/api';

function App() {
  const [user, setUser] = useState(null);
  const [notes, setNotes] = useState([]);
  const [selectedNote, setSelectedNote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [anchorEl, setAnchorEl] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncInProgress, setSyncInProgress] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [maxRetries] = useState(3);
  
  // Mobile navigation state
  const [mobileView, setMobileView] = useState('list'); // 'list' or 'editor'
  const [pendingSave, setPendingSave] = useState(null);
  
  // Responsive breakpoints
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'), {
    defaultMatches: false, // Always default to desktop view
    noSsr: true, // Disable server-side rendering conflicts
  });
  const isTablet = useMediaQuery(theme.breakpoints.between('md', 'lg'));

  // Helper functions FIRST (before they're used)
  const saveTemporaryNotesToStorage = (notes) => {
    const tempNotes = notes.filter(note => note.id.startsWith('temp_'));
    localStorage.setItem('tempNotes', JSON.stringify(tempNotes));
    console.log('Saved temporary notes to localStorage:', tempNotes.length);
  };

  const loadTemporaryNotesFromStorage = () => {
    try {
      const saved = localStorage.getItem('tempNotes');
      if (saved) {
        const tempNotes = JSON.parse(saved);
        console.log('Loaded temporary notes from localStorage:', tempNotes.length);
        return tempNotes;
      }
    } catch (error) {
      console.error('Failed to load temporary notes from localStorage:', error);
    }
    return [];
  };

  const removeTemporaryNoteFromStorage = (noteId) => {
    try {
      const saved = localStorage.getItem('tempNotes');
      if (saved) {
        const tempNotes = JSON.parse(saved);
        const filtered = tempNotes.filter(note => note.id !== noteId);
        localStorage.setItem('tempNotes', JSON.stringify(filtered));
        console.log('Removed temporary note from localStorage:', noteId);
      }
    } catch (error) {
      console.error('Failed to remove temporary note from localStorage:', error);
    }
  };

  // Main functions
  const loadNotes = async () => {
    try {
      const response = await api.get('/api/notes');
      const serverNotes = response.data || [];
      
      const temporaryNotes = loadTemporaryNotesFromStorage();
      const allNotes = [...temporaryNotes, ...serverNotes];
      
      setNotes(allNotes);
      setErrorMessage('');
      
      console.log(`Loaded ${serverNotes.length} server notes and ${temporaryNotes.length} temporary notes`);
    } catch (error) {
      console.error('Failed to load notes:', error);
      
      const temporaryNotes = loadTemporaryNotesFromStorage();
      if (temporaryNotes.length > 0) {
        setNotes(temporaryNotes);
        console.log(`Loaded ${temporaryNotes.length} temporary notes from localStorage (server unavailable)`);
      }
      
      if (!api.isNetworkError(error) && isOnline) {
        setErrorMessage('Failed to load notes. Please try again.');
      }
    }
  };

  const syncTemporaryNotes = async () => {
    console.log('Starting sync of temporary notes...');
    
    const temporaryNotes = loadTemporaryNotesFromStorage();
    
    if (temporaryNotes.length === 0) {
      console.log('No temporary notes to sync');
      return;
    }
    
    console.log(`Syncing ${temporaryNotes.length} temporary notes...`);
    setSyncInProgress(true);
    
    for (const tempNote of temporaryNotes) {
      try {
        console.log(`Syncing temporary note: ${tempNote.id}`, tempNote.title || 'Untitled');
        
        const response = await api.post('/api/notes', {
          title: tempNote.title || '',
          content: tempNote.content || ''
        });
        
        const serverNote = response.data;
        console.log(`Successfully created server note: ${serverNote.id}`);
        
        setNotes(prevNotes => {
          const updatedNotes = prevNotes.map(note => 
            note.id === tempNote.id ? serverNote : note
          );
          console.log('Updated notes state after sync');
          return updatedNotes;
        });
        
        setSelectedNote(prevSelected => {
          if (prevSelected && prevSelected.id === tempNote.id) {
            console.log('Updated selected note after sync');
            return serverNote;
          }
          return prevSelected;
        });
        
        removeTemporaryNoteFromStorage(tempNote.id);
        console.log(`Successfully synced temporary note ${tempNote.id} -> ${serverNote.id}`);
        
      } catch (error) {
        console.error(`Failed to sync temporary note ${tempNote.id}:`, error);
      }
    }
    
    setSyncInProgress(false);
    console.log('Finished syncing temporary notes');
  };

  const setupOfflineListeners = () => {
    const handleBrowserOnline = async () => {
      console.log('Browser detected: online');
      setIsOnline(true);
      setRetryCount(0);
      setErrorMessage('');
      
      setTimeout(async () => {
        try {
          console.log('Triggering sync after coming online...');
          await syncTemporaryNotes();
          await loadNotes();
        } catch (error) {
          console.error('Failed to sync temporary notes:', error);
        }
      }, 2000);
    };

    const handleBrowserOffline = () => {
      console.log('Browser detected: offline');
      setIsOnline(false);
    };

    window.addEventListener('online', handleBrowserOnline);
    window.addEventListener('offline', handleBrowserOffline);
    
    setIsOnline(navigator.onLine);

    api.addEventListener('online', async () => {
      console.log('API detected: online');
      setIsOnline(true);
      setRetryCount(0);
      setErrorMessage('');
      
      setTimeout(async () => {
        try {
          console.log('API online - triggering sync...');
          await syncTemporaryNotes();
          await loadNotes();
        } catch (error) {
          console.error('Failed to sync temporary notes:', error);
        }
      }, 2000);
    });
    
    api.addEventListener('offline', () => {
      console.log('API detected: offline');
      setIsOnline(false);
    });
    
    api.addEventListener('sync-start', () => setSyncInProgress(true));
    api.addEventListener('sync-complete', () => {
      setSyncInProgress(false);
      setRetryCount(0);
      loadNotes();
    });
    
    api.addEventListener('sync-error', (event) => {
      setSyncInProgress(false);
      const error = event.detail.error;
      console.error('Sync error:', error);
      
      if (retryCount < maxRetries) {
        setRetryCount(prev => prev + 1);
        setTimeout(() => {
          if (isOnline) {
            api.forcSync();
          }
        }, 5000 * (retryCount + 1));
      } else {
        setErrorMessage('Failed to sync changes after multiple attempts. Your notes are saved locally and will sync when connection improves.');
        setShowErrorDialog(true);
      }
    });
    
    api.addEventListener('offline-change', () => {
      loadNotes();
    });

    return () => {
      window.removeEventListener('online', handleBrowserOnline);
      window.removeEventListener('offline', handleBrowserOffline);
    };
  };

  const createNote = async () => {
    try {
      if (pendingSave && selectedNote) {
        await updateNote(selectedNote.id, pendingSave);
        setPendingSave(null);
      }

      if (!isOnline) {
        const tempNote = {
          id: `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          title: '',
          content: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          offline: true,
          pendingSync: true,
          permission: 'edit'
        };
        
        const newNotes = [tempNote, ...notes];
        setNotes(newNotes);
        setSelectedNote(tempNote);
        
        saveTemporaryNotesToStorage(newNotes);
        
        if (isMobile) {
          setMobileView('editor');
        }
        
        setErrorMessage('');
        return;
      }

      const response = await api.post('/api/notes', {
        title: '',
        content: ''
      });
      const newNote = response.data;
      setNotes([newNote, ...notes]);
      setSelectedNote(newNote);
      
      if (isMobile) {
        setMobileView('editor');
      }
      
      setErrorMessage('');
    } catch (error) {
      console.error('Failed to create note:', error);
      
      if (api.isNetworkError(error) && !isOnline) {
        const tempNote = {
          id: `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          title: '',
          content: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          offline: true,
          pendingSync: true,
          permission: 'edit'
        };
        
        const newNotes = [tempNote, ...notes];
        setNotes(newNotes);
        setSelectedNote(tempNote);
        
        saveTemporaryNotesToStorage(newNotes);
        
        if (isMobile) {
          setMobileView('editor');
        }
        
        setErrorMessage('');
      } else {
        setErrorMessage('Failed to create note. Please try again.');
        setShowErrorDialog(true);
      }
    }
  };

  const updateNote = async (id, updates) => {
    try {
      const isTemporaryNote = id.startsWith('temp_');
      
      if (isTemporaryNote) {
        const updatedNote = {
          ...notes.find(note => note.id === id),
          ...updates,
          updatedAt: new Date().toISOString(),
          offline: true,
          pendingSync: true
        };
        
        const newNotes = notes.map(note => note.id === id ? updatedNote : note);
        setNotes(newNotes);
        if (selectedNote && selectedNote.id === id) {
          setSelectedNote(updatedNote);
        }
        
        saveTemporaryNotesToStorage(newNotes);
        
        console.log('Updated temporary note locally:', id);
        return;
      }
      
      const response = await api.put(`/api/notes/${id}`, updates);
      const updatedNote = response.data;
      setNotes(notes.map(note => note.id === id ? updatedNote : note));
      if (selectedNote && selectedNote.id === id) {
        setSelectedNote(updatedNote);
      }
      setErrorMessage('');
    } catch (error) {
      console.error('Failed to update note:', error);
      
      if (api.isNetworkError(error)) {
        const updatedNote = {
          ...notes.find(note => note.id === id),
          ...updates,
          updatedAt: new Date().toISOString(),
          offline: true,
          pendingSync: true
        };
        
        const newNotes = notes.map(note => note.id === id ? updatedNote : note);
        setNotes(newNotes);
        if (selectedNote && selectedNote.id === id) {
          setSelectedNote(updatedNote);
        }
        
        if (id.startsWith('temp_')) {
          saveTemporaryNotesToStorage(newNotes);
        }
        
        console.log('Updated note locally due to network error:', id);
      } else {
        setErrorMessage('Failed to save note to server. Your changes are saved locally.');
      }
    }
  };

  const deleteNote = async (id) => {
    try {
      await api.delete(`/api/notes/${id}`);
      setNotes(notes.filter(note => note.id !== id));
      if (selectedNote && selectedNote.id === id) {
        setSelectedNote(null);
        if (isMobile) {
          setMobileView('list');
        }
      }
      setErrorMessage('');
    } catch (error) {
      console.error('Failed to delete note:', error);
      
      if (api.isNetworkError(error) && !isOnline) {
        setNotes(notes.filter(note => note.id !== id));
        if (selectedNote && selectedNote.id === id) {
          setSelectedNote(null);
          if (isMobile) {
            setMobileView('list');
          }
        }
      } else {
        setErrorMessage('Failed to delete note. Please try again.');
        setShowErrorDialog(true);
      }
    }
  };

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (token) {
      localStorage.setItem('token', token);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get('action');
    if (action === 'new') {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    checkAuth();
    setupPWAListeners();
    
    const cleanupOfflineListeners = setupOfflineListeners();
    
    return () => {
      if (cleanupOfflineListeners) {
        cleanupOfflineListeners();
      }
    };
  }, []);

  // Event handlers
  const handleNoteSelect = async (note) => {
    if (pendingSave && selectedNote) {
      try {
        await updateNote(selectedNote.id, pendingSave);
        setPendingSave(null);
      } catch (error) {
        console.error('Failed to save before switching notes:', error);
      }
    }
    
    setSelectedNote(note);
    
    if (isMobile) {
      setMobileView('editor');
    }
  };

  const handleBackToList = async () => {
    if (pendingSave && selectedNote) {
      try {
        await updateNote(selectedNote.id, pendingSave);
        setPendingSave(null);
      } catch (error) {
        console.error('Failed to save before going back:', error);
      }
    }
    
    if (isMobile) {
      setMobileView('list');
    } else {
      setSelectedNote(null);
    }
  };

  const handleNoteUpdate = (noteId, updates) => {
    setPendingSave(updates);
    return updateNote(noteId, updates);
  };

  const setupPWAListeners = () => {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    });

    window.addEventListener('appinstalled', () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    });

    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      setIsInstalled(true);
    }
  };

  const handleInstallClick = async () => {
    if (!installPrompt) return;

    const result = await installPrompt.prompt();
    console.log('Install prompt result:', result);
    setInstallPrompt(null);
  };

  const checkAuth = async () => {
    console.log('Starting auth check...');
    
    try {
      const token = localStorage.getItem('token');
      console.log('Auth check - Token exists:', !!token);
      
      if (!token) {
        console.log('No token found, user needs to login');
        setLoading(false);
        return;
      }

      api.api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      
      console.log('Attempting to get current user...');
      const userData = await api.getCurrentUser();
      console.log('getCurrentUser result:', !!userData, userData?.email);
      
      if (userData) {
        console.log('User authenticated successfully:', userData.email);
        setUser(userData);
        await loadNotes();
        
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('action') === 'new') {
          setTimeout(() => createNote(), 500);
        }
      } else {
        console.log('No valid user data available - but NOT clearing token yet');
        console.log('This might be a temporary issue, trying one more time...');
        
        setTimeout(async () => {
          try {
            const userData2 = await api.getCurrentUser();
            if (userData2) {
              console.log('Second attempt successful:', userData2.email);
              setUser(userData2);
              await loadNotes();
            } else {
              console.log('Second attempt also failed, clearing auth');
              await handleAuthFailure();
            }
          } catch (error2) {
            console.error('Second auth attempt failed:', error2);
          } finally {
            setLoading(false);
          }
        }, 2000);
        return;
      }
    } catch (error) {
      console.error('Auth check failed with error:', error);
      
      if (error.response?.status === 401) {
        console.log('401 error - definitely clearing token');
        await handleAuthFailure();
      } else if (!isOnline) {
        console.log('Offline auth check failed - keeping token, user can retry');
      } else {
        console.log('Non-auth error - keeping token, user can retry');
        setErrorMessage('Failed to verify authentication. Please check your connection and try again.');
        setShowErrorDialog(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAuthFailure = async () => {
    localStorage.removeItem('token');
    delete api.api.defaults.headers.common['Authorization'];
    await api.clearAuthData();
  };

  const logout = async () => {
    try {
      if (pendingSave && selectedNote) {
        await updateNote(selectedNote.id, pendingSave);
        setPendingSave(null);
      }

      await api.api.post('/auth/logout');
    } catch (error) {
      console.error('Logout request failed:', error);
    }
    
    localStorage.removeItem('token');
    delete api.api.defaults.headers.common['Authorization'];
    await api.clearAuthData();
    setUser(null);
    setNotes([]);
    setSelectedNote(null);
    setAnchorEl(null);
    setMobileView('list');
  };

  const handleSyncNow = async () => {
    if (isOnline && !syncInProgress) {
      try {
        const success = await api.forcSync();
        if (!success) {
          setErrorMessage('Sync failed. Please check your connection.');
          setShowErrorDialog(true);
        }
      } catch (error) {
        console.error('Manual sync failed:', error);
        setErrorMessage('Sync failed. Your changes are saved locally and will sync automatically when connection improves.');
        setShowErrorDialog(true);
      }
    }
  };

  const handleRetry = async () => {
    setShowErrorDialog(false);
    setErrorMessage('');
    
    if (!user) {
      setLoading(true);
      await checkAuth();
    } else {
      await loadNotes();
    }
  };

  const getConnectionStatusColor = () => {
    if (syncInProgress) return 'info';
    return isOnline ? 'success' : 'warning';
  };

  const getConnectionStatusLabel = () => {
    if (syncInProgress) return 'Syncing...';
    return isOnline ? 'Online' : 'Offline';
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="100vh">
        <Box textAlign="center">
          <CircularProgress size={40} sx={{ mb: 2 }} />
          <Typography variant="h5">Loading...</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Checking authentication and loading your notes
          </Typography>
        </Box>
      </Box>
    );
  }

  if (!user) {
    return (
      <>
        <Login />
        <OfflineStatus />
        
        <Snackbar
          open={!!errorMessage && !showErrorDialog}
          autoHideDuration={6000}
          onClose={() => setErrorMessage('')}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert 
            severity="error" 
            onClose={() => setErrorMessage('')}
            action={
              <Button color="inherit" size="small" onClick={handleRetry}>
                Retry
              </Button>
            }
          >
            {errorMessage}
          </Alert>
        </Snackbar>
      </>
    );
  }

  const shouldShowList = !isMobile || mobileView === 'list';
  const shouldShowEditor = !isMobile || mobileView === 'editor';

  return (
    <Router>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <AppBar position="static" elevation={1}>
          <Toolbar sx={{ 
            minHeight: isMobile ? '64px' : '72px',
            px: isMobile ? 1 : 3
          }}>
            <Typography 
              variant={isMobile ? "h6" : "h5"} 
              sx={{ 
                flexGrow: 1, 
                fontWeight: 500,
                fontSize: isMobile ? '1.25rem' : '1.5rem'
              }}
            >
              Material Notes
              {isInstalled && (
                <Typography 
                  component="span" 
                  variant="caption" 
                  sx={{ 
                    ml: 1, 
                    px: 1, 
                    py: 0.5, 
                    backgroundColor: 'rgba(255,255,255,0.2)', 
                    borderRadius: 1,
                    fontSize: '0.7rem'
                  }}
                >
                  PWA
                </Typography>
              )}
            </Typography>
            
            <Chip
              icon={syncInProgress ? <SyncIcon className="rotating" /> : (isOnline ? <WifiIcon /> : <WifiOffIcon />)}
              label={getConnectionStatusLabel()}
              color={getConnectionStatusColor()}
              size="small"
              sx={{ 
                mr: isMobile ? 1 : 2,
                '& .MuiChip-label': {
                  fontSize: isMobile ? '0.75rem' : '0.875rem'
                }
              }}
            />
            
            {!isMobile && isOnline && !syncInProgress && (
              <IconButton
                color="inherit"
                onClick={handleSyncNow}
                sx={{ mr: 1 }}
                title="Sync now"
              >
                <SyncIcon />
              </IconButton>
            )}
            
            {!isMobile && installPrompt && !isInstalled && (
              <IconButton
                color="inherit"
                onClick={handleInstallClick}
                sx={{ mr: 1 }}
                title="Install app"
              >
                <InstallIcon />
              </IconButton>
            )}
            
            {!isMobile && (
              <Button
                color="inherit"
                startIcon={<AddIcon />}
                onClick={createNote}
                sx={{ mr: 2, fontSize: '1rem', px: 3 }}
              >
                New Note
              </Button>
            )}
            
            <Button
              color="inherit"
              onClick={(e) => setAnchorEl(e.currentTarget)}
              sx={{ 
                fontSize: isMobile ? '0.875rem' : '1rem',
                minWidth: isMobile ? 'auto' : 'initial',
                px: isMobile ? 1 : 2
              }}
            >
              <Avatar 
                src={user.avatar} 
                sx={{ 
                  width: isMobile ? 32 : 36, 
                  height: isMobile ? 32 : 36, 
                  mr: isMobile ? 0.5 : 1 
                }}
              >
                <AccountCircle />
              </Avatar>
              {!isMobile && user.name}
            </Button>
            
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={() => setAnchorEl(null)}
              sx={{ '& .MuiMenuItem-root': { fontSize: '1rem' } }}
            >
              <MenuItem onClick={logout}>Logout</MenuItem>
            </Menu>
          </Toolbar>
        </AppBar>

        <Box sx={{ 
          display: 'flex', 
          flexGrow: 1, 
          overflow: 'hidden', 
          height: `calc(100vh - ${isMobile ? '64px' : '72px'})`,
          position: 'relative'
        }}>
          {shouldShowList && (
            <Box
              sx={{
                width: isMobile ? '100%' : (isTablet ? '400px' : '360px'),
                minWidth: isMobile ? '100%' : (isTablet ? '400px' : '360px'),
                maxWidth: isMobile ? '100%' : (isTablet ? '400px' : '360px'),
                display: isMobile && mobileView !== 'list' ? 'none' : 'block',
                flexShrink: 0,
                height: '100%',
                zIndex: isMobile ? 1 : 'auto'
              }}
            >
              <NotesList
                notes={notes}
                selectedNote={selectedNote}
                onSelectNote={handleNoteSelect}
                onDeleteNote={deleteNote}
                onCreateNote={createNote}
                isMobile={isMobile}
              />
            </Box>
          )}

          {shouldShowEditor && selectedNote && (
            <Box
              sx={{
                flexGrow: 1,
                width: isMobile ? '100%' : 'auto',
                display: isMobile && mobileView !== 'editor' ? 'none' : 'block',
                position: isMobile ? 'absolute' : 'relative',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: isMobile ? 2 : 'auto',
                backgroundColor: 'background.default'
              }}
            >
              <NoteEditor
                note={selectedNote}
                onUpdateNote={handleNoteUpdate}
                onBack={handleBackToList}
                isMobile={isMobile}
              />
            </Box>
          )}

          {!isMobile && !selectedNote && (
            <Box
              sx={{
                flexGrow: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'background.default',
              }}
            >
              <Typography variant="h5" color="text.secondary">
                Select a note to start editing
              </Typography>
            </Box>
          )}
        </Box>

        {isMobile && mobileView === 'list' && (
          <Fab
            color="primary"
            aria-label="add note"
            onClick={createNote}
            sx={{
              position: 'fixed',
              bottom: 24,
              right: 24,
              zIndex: 1000
            }}
          >
            <AddIcon />
          </Fab>
        )}
      </Box>
      
      <OfflineStatus />
      
      <Dialog open={showErrorDialog} onClose={() => setShowErrorDialog(false)}>
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <WarningIcon color="warning" />
            Connection Issue
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body1" gutterBottom>
            {errorMessage}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Your notes are always saved locally and will sync automatically when your connection improves.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowErrorDialog(false)}>
            OK
          </Button>
          <Button onClick={handleRetry} variant="contained">
            Retry
          </Button>
        </DialogActions>
      </Dialog>
      
      <Snackbar
        open={!!errorMessage && !showErrorDialog}
        autoHideDuration={6000}
        onClose={() => setErrorMessage('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{
          bottom: isMobile && mobileView === 'list' ? 100 : 24
        }}
      >
        <Alert 
          severity="warning" 
          onClose={() => setErrorMessage('')}
          action={
            <Button color="inherit" size="small" onClick={() => setShowErrorDialog(true)}>
              Details
            </Button>
          }
        >
          Connection issue detected
        </Alert>
      </Snackbar>

      <style jsx>{`
        @keyframes rotate {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        
        .rotating {
          animation: rotate 2s linear infinite;
        }
      `}</style>
    </Router>
  );
}

export default App;
