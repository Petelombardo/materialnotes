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
  WifiOff as WifiOffIcon,
  Smartphone,
  AutoAwesome as AutoAwesomeIcon,
  FlashOn as RealtimeIcon
} from '@mui/icons-material';
import Login from './components/Login';
import NoteEditor from './components/NoteEditor';
import NotesList from './components/NotesList';
import OfflineStatus from './components/OfflineStatus';
import api from './utils/api';
import websocketService from './services/websocketService';

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
  
  // Enhanced sync and mobile state
  const [notesTimestamps, setNotesTimestamps] = useState(new Map());
  const [refreshIntervalId, setRefreshIntervalId] = useState(null);
  const [bulkSyncInProgress, setBulkSyncInProgress] = useState(false);
  const [lastBulkSync, setLastBulkSync] = useState(null);
  const [appLifecycleStatus, setAppLifecycleStatus] = useState('active');
  
  // WebSocket state
  const [websocketConnected, setWebsocketConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState('connecting'); // 'connecting', 'websocket', 'http', 'offline'
  const [realtimeActive, setRealtimeActive] = useState(false);
  
  // NEW: Enhanced lifecycle state variables
  const [appVisibility, setAppVisibility] = useState('visible');
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [lastActivityTime, setLastActivityTime] = useState(Date.now());
  
  // Responsive breakpoints
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'), {
    defaultMatches: false,
    noSsr: true,
  });
  const isTablet = useMediaQuery(theme.breakpoints.between('md', 'lg'));

  // ===== WEBSOCKET INTEGRATION =====
  
  // Initialize WebSocket connection
  const initializeWebSocket = async () => {
    if (!user) {
      console.log('⚠️ No user available for WebSocket initialization');
      return;
    }

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        console.warn('⚠️ No auth token available for WebSocket');
        setConnectionMode('http');
        return;
      }

      console.log('🔌 Initializing WebSocket connection...');
      setConnectionMode('connecting');
      
      await websocketService.connect(token);
      
      setWebsocketConnected(true);
      setConnectionMode('websocket');
      console.log('✅ WebSocket connected successfully');
      
      // Stop HTTP polling since we have WebSocket
      stopHttpPolling();
      
    } catch (error) {
      console.error('❌ WebSocket initialization failed:', error);
      setWebsocketConnected(false);
      setConnectionMode('http');
      
      // Fall back to HTTP polling
      console.log('🔄 Falling back to HTTP polling');
      startHttpPolling();
    }
  };

  // Setup WebSocket connection event listeners (non-state dependent)
  const setupWebSocketConnectionListeners = () => {
    if (!websocketService) return;

    // Connection events
    websocketService.on('connection-restored', () => {
      console.log('🔌 WebSocket connection restored');
      setWebsocketConnected(true);
      setConnectionMode('websocket');
      setReconnectAttempts(0);
      stopHttpPolling();
    });

    websocketService.on('connection-lost', () => {
      console.log('🔌 WebSocket connection lost');
      setWebsocketConnected(false);
      setConnectionMode('http');
      setRealtimeActive(false);
      
      // Fall back to HTTP polling
      startHttpPolling();
    });

    websocketService.on('connection-failed', () => {
      console.log('❌ WebSocket connection failed permanently');
      setWebsocketConnected(false);
      setConnectionMode('http');
      setRealtimeActive(false);
      
      // Fall back to HTTP polling
      startHttpPolling();
    });

    // Handle connection confirmation
    websocketService.on('connection-confirmed', (data) => {
      console.log('✅ WebSocket connection confirmed:', data.user.name);
      setRealtimeActive(true);
    });

    websocketService.on('bulk-sync-response', (data) => {
      console.log('📱 Bulk sync response received:', data);
      // Handle bulk sync response if needed
    });

    websocketService.on('websocket-error', (error) => {
      console.error('❌ WebSocket error:', error);
      setConnectionMode('http');
    });
  };

  // Enhanced reconnectWebSocket function with better error handling
const reconnectWebSocket = async () => {
  // Check connectivity first
  if (!isOnline) {
    console.log('⚠️ Cannot reconnect WebSocket - offline');
    setConnectionMode('offline');
    return;
  }

  // Validate token before attempting connection
  const token = localStorage.getItem('token');
  if (!token) {
    console.log('❌ No auth token available for WebSocket connection');
    setConnectionMode('http');
    startHttpPolling();
    return;
  }

  // Validate token format and expiration
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const now = Date.now() / 1000;
    
    if (payload.exp && payload.exp < now) {
      console.log('❌ Token expired, cannot reconnect WebSocket');
      await handleAuthFailure();
      return;
    }
    
    if (!payload.id) {
      console.log('❌ Invalid token: missing user ID');
      await handleAuthFailure();
      return;
    }
  } catch (error) {
    console.error('❌ Token validation failed:', error);
    await handleAuthFailure();
    return;
  }

  // Ensure user session is available
  if (!user) {
    console.log('🔄 Restoring user session before WebSocket connection...');
    
    try {
      api.api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      const userData = await api.getCurrentUser();
      
      if (!userData) {
        console.log('❌ Could not restore user session');
        await handleAuthFailure();
        return;
      }
      
      console.log('✅ User session restored for WebSocket:', userData.email);
      setUser(userData);
    } catch (error) {
      console.error('❌ Failed to restore user session for WebSocket:', error);
      if (error.response?.status === 401) {
        await handleAuthFailure();
      } else {
        setConnectionMode('http');
        startHttpPolling();
      }
      return;
    }
  }

  try {
    console.log('🔄 Attempting WebSocket reconnection...');
    setConnectionMode('connecting');
    setReconnectAttempts(prev => prev + 1);
    
    // Clean disconnect first
    if (websocketService) {
      websocketService.disconnect();
    }
    
    // Wait for clean disconnection
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('🔌 Connecting WebSocket with validated token...');
    await websocketService.connect(token);
    
    setWebsocketConnected(true);
    setConnectionMode('websocket');
    setReconnectAttempts(0);
    
    console.log('✅ WebSocket reconnected successfully');
    
    // Stop HTTP polling since we have WebSocket
    stopHttpPolling();
    
    // Rejoin note collaboration if needed
    if (selectedNote) {
      console.log('🤝 Rejoining note collaboration after reconnect');
      setTimeout(() => {
        websocketService.joinNote(selectedNote.id);
      }, 500);
    }
    
  } catch (error) {
    console.error('❌ WebSocket reconnection failed:', error);
    setWebsocketConnected(false);
    
    // Handle specific error types
    if (error.message?.includes('Token expired') || error.message?.includes('Authentication failed')) {
      console.log('❌ Authentication failed, clearing session');
      await handleAuthFailure();
      return;
    }
    
    setConnectionMode('http');
    console.log('🔄 Falling back to HTTP polling after WebSocket failure');
    startHttpPolling();
    
    // Retry with exponential backoff (max 3 attempts)
    if (reconnectAttempts < 3 && isOnline) {
      const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 30000);
      console.log(`🔄 Will retry WebSocket in ${delay/1000}s (attempt ${reconnectAttempts + 1}/3)`);
      
      setTimeout(() => {
        if (isOnline && !websocketConnected) {
          reconnectWebSocket();
        }
      }, delay);
    } else {
      console.log('❌ Max WebSocket reconnection attempts reached or offline');
    }
  }
};

  // Start HTTP polling (fallback only)
  const startHttpPolling = () => {
    // Only start HTTP polling if WebSocket is not connected
    if (websocketConnected) {
      console.log('⚠️ Skipping HTTP polling - WebSocket active');
      return;
    }

    if (refreshIntervalId) {
      console.log('🛑 Stopping existing HTTP polling before starting new one');
      clearInterval(refreshIntervalId);
    }
    
    console.log('🔄 Starting HTTP polling fallback (every 30 seconds)');
    
    const intervalId = setInterval(() => {
      // Only poll if WebSocket is not connected
      if (!websocketConnected) {
        console.log('⏰ HTTP polling interval triggered');
        checkForNoteUpdates(true);
      }
    }, 30000);
    
    setRefreshIntervalId(intervalId);
  };

  // Stop HTTP polling
  const stopHttpPolling = () => {
    if (refreshIntervalId) {
      console.log('🛑 Stopping HTTP polling');
      clearInterval(refreshIntervalId);
      setRefreshIntervalId(null);
    }
  };

  // ===== EXISTING HELPER FUNCTIONS =====
  
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

  // Enhanced note update handling (HTTP fallback only)
  const checkForNoteUpdates = async (silent = true) => {
    // Skip if WebSocket is handling updates
    if (websocketConnected) {
      if (!silent) console.log('⚠️ Skipping HTTP update check - WebSocket active');
      return;
    }

    if (!user || !isOnline) {
      if (!silent) console.log('📝 Skipping note updates check - user:', !!user, 'online:', isOnline);
      return;
    }
    
    try {
      if (!silent) console.log('📝 Checking for note updates via HTTP...');
      
      const response = await api.get('/api/notes');
      const serverNotes = response.data || [];
      
      const temporaryNotes = loadTemporaryNotesFromStorage();
      const allNotes = [...temporaryNotes, ...serverNotes];
      
      // Check if any notes have been updated
      let hasUpdates = false;
      const newTimestamps = new Map();
      const updatedNotes = [];
      
      allNotes.forEach(note => {
        if (note.updatedAt) {
          const newTime = new Date(note.updatedAt).getTime();
          const oldTime = notesTimestamps.get(note.id);
          newTimestamps.set(note.id, newTime);
          
          if (oldTime && newTime > oldTime) {
            hasUpdates = true;
            updatedNotes.push({
              id: note.id,
              title: note.title || 'Untitled',
              shared: note.shared,
              hasBeenShared: note.hasBeenShared,
              lastEditor: note.lastEditorName || 'Unknown'
            });
            console.log('🔄 Note updated detected via HTTP:', {
              id: note.id,
              title: note.title || 'Untitled',
              shared: note.shared,
              hasBeenShared: note.hasBeenShared,
              oldTime: new Date(oldTime).toLocaleTimeString(),
              newTime: new Date(newTime).toLocaleTimeString(),
              lastEditor: note.lastEditorName || 'Unknown'
            });
          }
        }
      });
      
      // Update notes if there are changes or if this is the first load
      if (hasUpdates || notesTimestamps.size === 0) {
        setNotes(allNotes);
        setNotesTimestamps(newTimestamps);
        
        if (hasUpdates) {
          console.log('✅ Applied HTTP updates to', updatedNotes.length, 'notes:', updatedNotes);
        }
        
        // CRITICAL FIX: Update selected note if it was changed
        if (selectedNote) {
          const updatedSelectedNote = allNotes.find(note => note.id === selectedNote.id);
          if (updatedSelectedNote) {
            const selectedNoteTime = selectedNote.updatedAt ? new Date(selectedNote.updatedAt).getTime() : 0;
            const updatedNoteTime = updatedSelectedNote.updatedAt ? new Date(updatedSelectedNote.updatedAt).getTime() : 0;
            
            // Update if timestamps differ OR if we don't have updatedAt on selected note
            if (updatedNoteTime !== selectedNoteTime || !selectedNote.updatedAt) {
              console.log('🔄 Updating selected note via HTTP:', {
                id: selectedNote.id,
                title: selectedNote.title || 'Untitled',
                oldTime: selectedNote.updatedAt,
                newTime: updatedSelectedNote.updatedAt,
                contentChanged: selectedNote.content !== updatedSelectedNote.content
              });
              setSelectedNote(updatedSelectedNote);
            }
          }
        }
        
        if (hasUpdates && !silent) {
          console.log('🔄 Notes updated from server via HTTP');
        }
      } else {
        if (!silent) console.log('✅ No note updates detected via HTTP');
      }
      
    } catch (error) {
      if (!silent) {
        console.error('❌ Failed to check for note updates via HTTP:', error);
      }
    }
  };

  // Handle notes updated from WebSocket or bulk sync
  const handleNotesUpdated = (updatedNotes) => {
    console.log('🔥 Handling note updates from WebSocket/bulk sync:', updatedNotes.length);
    
    // DEBUG: Log what we're about to process
    if (updatedNotes.length > 0) {
      console.log('🔍 First updated note sample:', {
        id: updatedNotes[0].id,
        title: updatedNotes[0].title,
        content: updatedNotes[0].content?.substring(0, 100) + '...',
        updatedAt: updatedNotes[0].updatedAt
      });
    }
    
    // DEBUG: Log current selected note before update
    if (selectedNote) {
      console.log('🔍 Current selected note before update:', {
        id: selectedNote.id,
        title: selectedNote.title,
        content: selectedNote.content?.substring(0, 100) + '...',
        updatedAt: selectedNote.updatedAt
      });
    }
    
    // First, identify which note needs to be updated for selected note (BEFORE state update)
    const selectedNoteUpdate = selectedNote ? 
      updatedNotes.find(note => note.id === selectedNote.id) : null;
    
    if (selectedNoteUpdate) {
      console.log('📝 Selected note will be updated with:', {
        selectedNoteId: selectedNote.id,
        noteId: selectedNoteUpdate.id,
        oldContent: selectedNote.content?.substring(0, 100) + '...',
        newContent: selectedNoteUpdate.content?.substring(0, 100) + '...',
        contentChanged: selectedNote.content !== selectedNoteUpdate.content
      });
    }
    
    // Update the notes state with the new data
    setNotes(prevNotes => {
      const updatedNotesMap = new Map(updatedNotes.map(note => [note.id, note]));
      
      return prevNotes.map(note => {
        const updated = updatedNotesMap.get(note.id);
        if (updated) {
          console.log(`🔄 Updating note ${note.id} in App state`);
          return updated;
        }
        return note;
      });
    });
    
    // Update timestamps
    setNotesTimestamps(prev => {
      const updated = new Map(prev);
      updatedNotes.forEach(note => {
        if (note.updatedAt) {
          updated.set(note.id, new Date(note.updatedAt).getTime());
        }
      });
      return updated;
    });
    
    // CRITICAL FIX: Update selected note if it was affected (NOW WORKS!)
    if (selectedNoteUpdate) {
      console.log('🔄 Updating selected note from bulk sync:', {
        noteId: selectedNoteUpdate.id,
        title: selectedNoteUpdate.title,
        contentLength: selectedNoteUpdate.content?.length,
        fullContent: selectedNoteUpdate.content?.substring(0, 200) + '...'
      });
      setSelectedNote(selectedNoteUpdate);
    } else {
      console.log('⚠️ No selected note update found in bulk sync results:', {
        selectedNoteId: selectedNote?.id,
        updatedNotesCount: updatedNotes.length,
        updatedNoteIds: updatedNotes.map(note => note.id),
        firstUpdatedNote: updatedNotes[0]?.id
      });
    }
    
    setLastBulkSync(new Date());
  };

  // Modified loadNotes to also set up timestamps
  const loadNotes = async () => {
    try {
      const response = await api.get('/api/notes');
      const serverNotes = response.data || [];
      
      console.log('📋 App.js loaded notes sample:', {
        totalNotes: serverNotes.length,
        firstNote: serverNotes[0] ? {
          id: serverNotes[0].id,
          title: serverNotes[0].title,
          hasUpdatedAt: !!serverNotes[0].updatedAt,
          updatedAt: serverNotes[0].updatedAt,
          hasCreatedAt: !!serverNotes[0].createdAt,
          createdAt: serverNotes[0].createdAt,
          allKeys: Object.keys(serverNotes[0])
        } : 'No notes'
      });
      
      const temporaryNotes = loadTemporaryNotesFromStorage();
      const allNotes = [...temporaryNotes, ...serverNotes];
      
      setNotes(allNotes);
      setErrorMessage('');
      
      // Set up timestamps for future comparison
      const timestamps = new Map();
      allNotes.forEach(note => {
        if (note.updatedAt) {
          timestamps.set(note.id, new Date(note.updatedAt).getTime());
        }
      });
      setNotesTimestamps(timestamps);
      
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
        
        // Update timestamps
        setNotesTimestamps(prev => {
          const updated = new Map(prev);
          updated.delete(tempNote.id); // Remove temp note timestamp
          updated.set(serverNote.id, new Date(serverNote.updatedAt).getTime()); // Add server note timestamp
          return updated;
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

  // NEW: Enhanced setupOfflineListeners with standby/resume handling
const setupOfflineListeners = () => {
  const handleBrowserOnline = async () => {
    console.log('🌐 Browser detected: online');
    setIsOnline(true);
    setRetryCount(0);
    setErrorMessage('');
    
    // Add a small delay to ensure network is actually stable
    setTimeout(async () => {
      try {
        console.log('🔄 Triggering sync after coming online...');
        await syncTemporaryNotes();
        await loadNotes();
        
        // FIXED: Only try to reconnect WebSocket if user is available
        // Check user state at the time of reconnection, not when this function was defined
        if (user) {
          console.log('🔄 User available, attempting WebSocket reconnection...');
          await reconnectWebSocket();
        } else {
          console.log('⚠️ User not available during online event, checking auth state...');
          // If user is not available, try to restore auth first
          const token = localStorage.getItem('token');
          if (token) {
            console.log('🔑 Token exists, attempting to restore user session...');
            try {
              api.api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
              const userData = await api.getCurrentUser();
              if (userData) {
                console.log('✅ User session restored, now attempting WebSocket...');
                setUser(userData);
                // Wait a bit for user state to update, then try WebSocket
                setTimeout(() => {
                  if (userData) { // Use the fresh userData, not state
                    reconnectWebSocket();
                  }
                }, 1000);
              } else {
                console.log('❌ Could not restore user session');
                setConnectionMode('http');
                startHttpPolling();
              }
            } catch (error) {
              console.error('❌ Failed to restore user session:', error);
              setConnectionMode('http');
              startHttpPolling();
            }
          } else {
            console.log('❌ No token available, user needs to re-authenticate');
            setConnectionMode('offline');
          }
        }
      } catch (error) {
        console.error('❌ Failed to sync after coming online:', error);
      }
    }, 1000);
  };

  const handleBrowserOffline = () => {
    console.log('📱 Browser detected: offline');
    setIsOnline(false);
    setConnectionMode('offline');
    setWebsocketConnected(false);
    stopHttpPolling();
    // DON'T clear user state here - keep it for when we come back online
  };

  // Enhanced visibility change handler with better state preservation
  const handleVisibilityChange = async () => {
    const currentTime = Date.now();
    const wasHidden = appVisibility === 'hidden';
    const isNowVisible = document.visibilityState === 'visible';
    
    setAppVisibility(document.visibilityState);
    
    console.log(`👁️ App visibility changed: ${document.visibilityState}`);
    
    if (wasHidden && isNowVisible) {
      const timeSinceHidden = currentTime - lastActivityTime;
      console.log(`📱 App resumed after ${Math.round(timeSinceHidden / 1000)}s`);
      
      // Update last activity time AFTER calculating the difference
      setLastActivityTime(currentTime);
      
      // If we were hidden for more than 30 seconds, assume connections were lost
      if (timeSinceHidden > 30000) {
        console.log('🔄 Long sleep detected, forcing reconnection...');
        
        // Reset connection state but preserve user state
        setWebsocketConnected(false);
        setConnectionMode('connecting');
        
        // Check actual connectivity first
        try {
          const response = await fetch('/health', { 
            method: 'GET', 
            cache: 'no-cache',
            headers: { 'Cache-Control': 'no-cache' }
          });
          
          if (response.ok) {
            console.log('✅ Network connectivity confirmed after resume');
            setIsOnline(true);
            
            // FIXED: Check user state before attempting reconnection
            const currentUser = user; // Capture current user state
            if (currentUser) {
              console.log('🔄 User available after resume, reconnecting WebSocket...');
              await reconnectWebSocket();
            } else {
              console.log('⚠️ User not available after resume, checking auth...');
              // Try to restore user session
              const token = localStorage.getItem('token');
              if (token) {
                try {
                  api.api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
                  const userData = await api.getCurrentUser();
                  if (userData) {
                    console.log('✅ User session restored after resume');
                    setUser(userData);
                    setTimeout(() => reconnectWebSocket(), 1000);
                  } else {
                    console.log('❌ Could not restore user session after resume');
                    setConnectionMode('http');
                    startHttpPolling();
                  }
                } catch (error) {
                  console.error('❌ Auth restoration failed after resume:', error);
                  setConnectionMode('http');
                  startHttpPolling();
                }
              } else {
                console.log('❌ No token available after resume');
                setConnectionMode('offline');
              }
            }
          } else {
            throw new Error('Health check failed');
          }
        } catch (error) {
          console.log('❌ Network not available after resume');
          setIsOnline(false);
          setConnectionMode('offline');
        }
      } else if (!websocketConnected && isOnline) {
        // Short sleep, just reconnect WebSocket if needed
        console.log('🔄 Quick reconnection after short sleep...');
        if (user) {
          await reconnectWebSocket();
        } else {
          console.log('⚠️ User not available for quick reconnection, starting HTTP polling');
          setConnectionMode('http');
          startHttpPolling();
        }
      }
    } else {
      // Update last activity time when hiding
      setLastActivityTime(currentTime);
    }
  };

  // Page focus/blur handlers (additional layer)
  const handleFocus = async () => {
    console.log('🔍 Window focused');
    setLastActivityTime(Date.now());
    
    // Quick connectivity check on focus
    if (!websocketConnected && isOnline && user) {
      console.log('🔄 Quick reconnection on window focus...');
      setTimeout(() => reconnectWebSocket(), 500);
    }
  };

  const handleBlur = () => {
    console.log('😴 Window blurred');
    setLastActivityTime(Date.now());
  };

  // Page freeze/resume handlers (iOS Safari specific)
  const handleFreeze = () => {
    console.log('🧊 Page frozen (iOS/mobile specific)');
    setLastActivityTime(Date.now());
  };

  const handleResume = async () => {
    console.log('🔥 Page resumed (iOS/mobile specific)');
    const currentTime = Date.now();
    const timeFrozen = currentTime - lastActivityTime;
    
    console.log(`📱 Page was frozen for ${Math.round(timeFrozen / 1000)}s`);
    
    if (timeFrozen > 10000) { // More than 10 seconds
      console.log('🔄 Long freeze detected, forcing reconnection...');
      setLastActivityTime(currentTime); // Update time before calling visibility logic
      await handleVisibilityChange(); // Reuse the visibility logic
    }
  };

  // Set up all event listeners
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('blur', handleBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  // iOS specific events
  document.addEventListener('freeze', handleFreeze);
  document.addEventListener('resume', handleResume);
  
  // Page lifecycle events
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      console.log('📄 Page restored from cache');
      setTimeout(() => {
        if (user) {
          reconnectWebSocket();
        } else {
          console.log('⚠️ User not available from cache restore');
        }
      }, 1000);
    }
  });

  // Set initial states
  setIsOnline(navigator.onLine);
  setAppVisibility(document.visibilityState);
  setLastActivityTime(Date.now()); // Initialize activity time
  
  if (!navigator.onLine) {
    setConnectionMode('offline');
  }

  // API event listeners
  api.addEventListener('online', async () => {
    console.log('🔗 API detected: online');
    setIsOnline(true);
    setRetryCount(0);
    setErrorMessage('');
    
    setTimeout(async () => {
      try {
        console.log('API online - triggering sync...');
        await syncTemporaryNotes();
        await loadNotes();
        
        // FIXED: Check user state before attempting WebSocket reconnection
        if (user) {
          console.log('🔗 User available, attempting WebSocket reconnection via API event...');
          await reconnectWebSocket();
        } else {
          console.log('⚠️ User not available during API online event');
          setConnectionMode('http');
          startHttpPolling();
        }
      } catch (error) {
        console.error('Failed to sync after API online:', error);
      }
    }, 1000);
  });
  
  api.addEventListener('offline', () => {
    console.log('🔗 API detected: offline');
    setIsOnline(false);
    setConnectionMode('offline');
    setWebsocketConnected(false);
    stopHttpPolling();
    // DON'T clear user state here
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

  // Cleanup function
  return () => {
    window.removeEventListener('online', handleBrowserOnline);
    window.removeEventListener('offline', handleBrowserOffline);
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('blur', handleBlur);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('freeze', handleFreeze);
    document.removeEventListener('resume', handleResume);
    stopHttpPolling();
  };
};

// STOP
// STOP

  // Create note function
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
      
      // Update timestamps
      setNotesTimestamps(prev => {
        const updated = new Map(prev);
        updated.set(newNote.id, new Date(newNote.updatedAt).getTime());
        return updated;
      });
      
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
      
      // Update timestamps
      setNotesTimestamps(prev => {
        const updated = new Map(prev);
        updated.set(updatedNote.id, new Date(updatedNote.updatedAt).getTime());
        return updated;
      });
      
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
      
      // Remove from timestamps
      setNotesTimestamps(prev => {
        const updated = new Map(prev);
        updated.delete(id);
        return updated;
      });
      
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
      stopHttpPolling();
      
      // Cleanup WebSocket
      if (websocketService) {
        websocketService.disconnect();
      }
    };
  }, []);

  // Setup WebSocket when user is authenticated
  useEffect(() => {
    if (user) {
      console.log('🔌 User authenticated, setting up WebSocket...');
      setupWebSocketConnectionListeners();
      initializeWebSocket();
    }
  }, [user]);
  
  // Setup WebSocket real-time note update listeners (depends on selectedNote)
  useEffect(() => {
    if (!websocketService) return;
    
    console.log('🔧 Setting up WebSocket note-updated handler for selectedNote:', selectedNote?.id);
    
    const handleNoteUpdated = (data) => {
      console.log('📝 [NEW HANDLER] Real-time note update received in App.js:', data.noteId);
      
      let updatedNote = null;
      
      // Update the specific note in our notes array
      setNotes(prevNotes => {
        return prevNotes.map(note => {
          if (note.id === data.noteId) {
            updatedNote = {
              ...note,
              title: data.updates.title !== undefined ? data.updates.title : note.title,
              content: data.updates.content !== undefined ? data.updates.content : note.content,
              updatedAt: data.timestamp || data.updatedAt,
              lastEditedBy: data.editor?.id,
              lastEditorName: data.editor?.name,
              lastEditorAvatar: data.editor?.avatar
            };
            return updatedNote;
          }
          return note;
        });
      });
      
      // CRITICAL FIX: Update selectedNote if it's the note being updated
      // This now has access to the current selectedNote state
      if (selectedNote && selectedNote.id === data.noteId && updatedNote) {
        console.log('🔄 [SUCCESS] Updating selectedNote with real-time changes:', {
          noteId: data.noteId,
          selectedNoteId: selectedNote.id,
          oldContent: selectedNote.content?.substring(0, 50) + '...',
          newContent: updatedNote.content?.substring(0, 50) + '...'
        });
        setSelectedNote(updatedNote);
      } else {
        console.log('⚠️ [FAILED] Real-time update not applied to selectedNote:', {
          hasSelectedNote: !!selectedNote,
          selectedNoteId: selectedNote?.id,
          updateNoteId: data.noteId,
          hasUpdatedNote: !!updatedNote,
          idsMatch: selectedNote?.id === data.noteId
        });
      }
      
      // Update timestamps
      setNotesTimestamps(prev => {
        const updated = new Map(prev);
        updated.set(data.noteId, new Date(data.timestamp || data.updatedAt).getTime());
        return updated;
      });
    };
    
    // Add the handler (don't remove old ones for now to avoid breaking existing functionality)
    websocketService.on('note-updated', handleNoteUpdated);
    console.log('✅ WebSocket note-updated handler registered');
    
    // Cleanup function
    return () => {
      console.log('🧧 Cleaning up WebSocket note-updated handler');
      try {
        if (websocketService && websocketService.off) {
          websocketService.off('note-updated', handleNoteUpdated);
        }
      } catch (error) {
        console.warn('⚠️ Error removing WebSocket handler:', error);
      }
    };
    
  }, [selectedNote]); // Re-run when selectedNote changes

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
    
    console.log('📋 App.js selecting note for NoteEditor:', {
      noteId: note.id,
      title: note.title || 'Untitled',
      hasUpdatedAt: !!note.updatedAt,
      updatedAt: note.updatedAt,
      typeOfUpdatedAt: typeof note.updatedAt,
      hasCreatedAt: !!note.createdAt,
      createdAt: note.createdAt,
      shared: note.shared,
      hasBeenShared: note.hasBeenShared,
      fullNoteKeys: Object.keys(note)
    });
    
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
    console.log('🔑 Starting authentication check...');
    
    try {
      const token = localStorage.getItem('token');
      console.log('Auth check - Token exists:', !!token);
      
      if (!token) {
        console.log('No token found, user needs to login');
        setLoading(false);
        return;
      }

      // Validate token format and expiration before making API calls
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const now = Date.now() / 1000;
        
        if (payload.exp && payload.exp < now) {
          console.log('❌ Token expired during auth check');
          await handleAuthFailure();
          setLoading(false);
          return;
        }
        
        console.log('✅ Token format valid, expiry check passed');
      } catch (tokenError) {
        console.error('❌ Token validation failed:', tokenError);
        await handleAuthFailure();
        setLoading(false);
        return;
      }

      api.api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      
      console.log('Attempting to get current user...');
      const userData = await api.getCurrentUser();
      console.log('getCurrentUser result:', !!userData, userData?.email);
      
      if (userData) {
        console.log('✅ User authenticated successfully:', userData.email);
        setUser(userData);
        await loadNotes();
        
        // WebSocket initialization happens in useEffect when user is set
        
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('action') === 'new') {
          setTimeout(() => createNote(), 500);
        }
      } else {
        console.log('⚠️ No valid user data received - this may be a temporary issue');
        
        // Single retry with shorter timeout
        setTimeout(async () => {
          try {
            console.log('🔄 Retrying user authentication...');
            const userData2 = await api.getCurrentUser();
            if (userData2) {
              console.log('✅ Retry successful:', userData2.email);
              setUser(userData2);
              await loadNotes();
            } else {
              console.log('❌ Retry failed, clearing auth');
              await handleAuthFailure();
            }
          } catch (error2) {
            console.error('❌ Auth retry failed:', error2);
            if (error2.response?.status === 401) {
              await handleAuthFailure();
            }
          } finally {
            setLoading(false);
          }
        }, 1000); // Reduced from 2000ms
        return;
      }
    } catch (error) {
      console.error('❌ Auth check failed:', error);
      
      if (error.response?.status === 401) {
        console.log('❌ 401 Unauthorized - clearing session');
        await handleAuthFailure();
      } else if (error.response?.status === 429) {
        console.log('⚠️ Rate limited during auth check');
        setErrorMessage('Server is busy. Please wait a moment and try again.');
        setShowErrorDialog(true);
      } else if (!isOnline) {
        console.log('⚠️ Offline during auth check - keeping session');
        setConnectionMode('offline');
      } else {
        console.log('⚠️ Network error during auth check');
        setErrorMessage('Failed to verify authentication. Please check your connection.');
        setShowErrorDialog(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAuthFailure = async () => {
    console.log('❌ Handling authentication failure - clearing session');
    
    // Stop all connection attempts
    stopHttpPolling();
    if (websocketService) {
      websocketService.disconnect();
    }
    
    // Reset connection state
    setWebsocketConnected(false);
    setConnectionMode('offline');
    setRealtimeActive(false);
    setReconnectAttempts(0);
    
    // Clear auth data
    localStorage.removeItem('token');
    delete api.api.defaults.headers.common['Authorization'];
    await api.clearAuthData();
    
    // Clear user state to trigger re-login
    setUser(null);
    setNotes([]);
    setSelectedNote(null);
    setNotesTimestamps(new Map());
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
    
    stopHttpPolling();
    if (websocketService) {
      websocketService.disconnect();
    }
    setWebsocketConnected(false);
    setConnectionMode('offline');
    localStorage.removeItem('token');
    delete api.api.defaults.headers.common['Authorization'];
    await api.clearAuthData();
    setUser(null);
    setNotes([]);
    setSelectedNote(null);
    setAnchorEl(null);
    setMobileView('list');
    setNotesTimestamps(new Map());
  };

  const handleSyncNow = async () => {
    if (isOnline && !syncInProgress) {
      try {
        const success = await api.forcSync();
        if (!success) {
          setErrorMessage('Sync failed. Please check your connection.');
          setShowErrorDialog(true);
        } else {
          // Force a refresh after manual sync (only if using HTTP)
          if (!websocketConnected) {
            await checkForNoteUpdates(false);
          }
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
    switch (connectionMode) {
      case 'websocket': return 'success';
      case 'http': return 'warning';
      case 'offline': return 'error';
      case 'connecting': return 'info';
      default: return 'warning';
    }
  };

  const getConnectionStatusLabel = () => {
    if (syncInProgress) return 'Syncing...';
    switch (connectionMode) {
      case 'websocket': return 'Real-time';
      case 'http': return 'HTTP sync';
      case 'offline': return 'Offline';
      case 'connecting': return 'Connecting...';
      default: return 'Unknown';
    }
  };

  const getConnectionIcon = () => {
    if (syncInProgress) return <SyncIcon className="rotating" />;
    switch (connectionMode) {
      case 'websocket': return <RealtimeIcon />;
      case 'http': return <WifiIcon />;
      case 'offline': return <WifiOffIcon />;
      case 'connecting': return <SyncIcon className="rotating" />;
      default: return <WifiOffIcon />;
    }
  };

  // Render logic
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
              {connectionMode === 'websocket' && (
                <Typography 
                  component="span" 
                  variant="caption" 
                  sx={{ 
                    ml: 1, 
                    px: 1, 
                    py: 0.5, 
                    backgroundColor: 'rgba(255,255,255,0.15)', 
                    borderRadius: 1,
                    fontSize: '0.65rem'
                  }}
                >
                  ⚡ Real-time
                </Typography>
              )}
            </Typography>
            
            <Chip
              icon={getConnectionIcon()}
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
                currentUser={user}
              />
            </Box>
          )}

          {shouldShowEditor && selectedNote && (!isMobile || mobileView === 'editor') && (
            <Box
              sx={{
                flexGrow: 1,
                width: isMobile ? '100%' : 'auto',
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
                currentUser={user}
                notes={notes}
                onNotesUpdated={handleNotesUpdated}
                websocketConnected={websocketConnected}
                connectionMode={connectionMode}
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
