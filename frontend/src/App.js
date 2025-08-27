import React, { useState, useEffect, useRef } from 'react';
import fastDiff from 'fast-diff';
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
import offlineStorage from './utils/offlineStorage';
import connectionController from './services/ConnectionController';
import webSocketManager from './services/WebSocketManager';
import { syncService } from './services/syncService';

// Enhanced import testing for App.js diff utilities
let appDiffSystemWorking = false;
try {
  // Test the diff functionality
  const testOld = 'App Test Old';
  const testNew = 'App Test New';
  const testDiff = fastDiff(testOld, testNew);
  
  if (testDiff && Array.isArray(testDiff)) {
    appDiffSystemWorking = true;
    console.log('✅ [APP-DIFF] fast-diff library loaded and tested successfully in App.js');
  } else {
    console.error('❌ [APP-DIFF] fast-diff loaded but functionality test failed in App.js');
  }
} catch (error) {
  console.error('❌ [APP-DIFF] Failed to load fast-diff library in App.js:', error);
  console.log('📄 [APP-DIFF] App.js will use legacy full-content mode only');
}

// Development logging utility
const isDevelopment = process.env.NODE_ENV === 'development';
const devLog = (...args) => {
  if (isDevelopment) {
    console.log(...args);
  }
};

// Diff utility functions for handling diff-based updates
const applyContentDiff = (content, patches) => {
  if (!patches || patches.length === 0) {
    console.log('📦 [APP-DIFF] No patches to apply, returning original content');
    return content;
  }
  
  if (!appDiffSystemWorking) {
    console.error('❌ [APP-DIFF] Diff system not working, cannot apply patches');
    return content; // Return original content if diff system isn't working
  }
  
  console.log('🔧 [APP-DIFF] Applying patches:', {
    patchCount: patches.length,
    originalLength: content.length,
    diffSystemWorking: appDiffSystemWorking
  });
  
  let result = content;
  try {
    // Apply patches in reverse order to maintain positions
    for (let i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch.op === 'insert') {
        result = result.slice(0, patch.pos) + patch.text + result.slice(patch.pos);
        console.log(`➕ [APP-DIFF] Applied insert at ${patch.pos}: ${patch.text.substring(0, 20)}...`);
      } else if (patch.op === 'delete') {
        result = result.slice(0, patch.pos) + result.slice(patch.pos + patch.length);
        console.log(`➖ [APP-DIFF] Applied delete at ${patch.pos}, length: ${patch.length}`);
      }
    }
    
    console.log('✅ [APP-DIFF] Successfully applied all patches:', {
      resultLength: result.length,
      changed: result !== content
    });
    
  } catch (error) {
    console.error('❌ [APP-DIFF] Error applying patches:', error);
    return content; // Return original content on error
  }
  
  return result;
};

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
  
  // Track currently opened note for bulk sync updates
  const [currentlyOpenNoteId, setCurrentlyOpenNoteId] = useState(null);
  
  // Conflict resolution state
  const [conflicts, setConflicts] = useState([]);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  
  // WebSocket state - simplified
  const [websocketConnected, setWebsocketConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState('connecting'); // 'connecting', 'websocket', 'http', 'offline'
  const [realtimeActive, setRealtimeActive] = useState(false);
  
  // NEW: Enhanced lifecycle state variables
  const [appVisibility, setAppVisibility] = useState('visible');
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [lastActivityTime, setLastActivityTime] = useState(Date.now());
  
  // Rate limiting for polling start
  const [lastPollingStart, setLastPollingStart] = useState(0);
  
  // HTTP fallback timeout management
  const httpFallbackTimeoutRef = useRef(null);
  
  // Request deduplication
  const loadNotesInProgressRef = useRef(false);
  const syncInProgressRef = useRef(false);
  const lastApiOnlineEventRef = useRef(0);
  
  // Responsive breakpoints
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'), {
    defaultMatches: false,
    noSsr: true,
  });
  const isTablet = useMediaQuery(theme.breakpoints.between('md', 'lg'));

  // ===== SIMPLIFIED WEBSOCKET INTEGRATION =====
  
  // Setup WebSocket state sync from ConnectionController
  const setupConnectionControllerListeners = () => {
    let lastState = null;
    
    // Listen to ConnectionController state changes to update our UI
    const checkConnectionState = () => {
      const state = connectionController.getState();
      const wsState = state.webSocket;
      
      // Only update if state actually changed to prevent thrashing
      const currentStateKey = `${wsState.connected}-${state.isOnline}-${wsState.state}`;
      if (lastState === currentStateKey) {
        return; // No change, skip update
      }
      lastState = currentStateKey;
      
      devLog('🔄 Connection state changed:', {
        wsConnected: wsState.connected,
        online: state.isOnline,
        wsState: wsState.state
      });

      setWebsocketConnected(wsState.connected);
      setRealtimeActive(wsState.connected);
      
      if (wsState.connected) {
        setConnectionMode('websocket');
        stopHttpPolling();
        // Clear any lingering connection error messages when WebSocket is connected
        setErrorMessage('');
      } else if (state.isOnline) {
        setConnectionMode('http');
        // Also clear error messages when back online via HTTP
        setErrorMessage('');
        startHttpPolling();
      } else {
        setConnectionMode('offline');
        stopHttpPolling();
      }
    };
    
    // Listen to WebSocket events for immediate state updates
    webSocketManager.on('connected', () => {
      devLog('🔥 WebSocket connected');
      checkConnectionState(); // Update immediately
      
      // Clear any connection error messages immediately when WebSocket connects
      setErrorMessage('');
      
      // CRITICAL: Trigger bulk sync when WebSocket reconnects to catch up on missed changes
      setTimeout(async () => {
        try {
          devLog('🔄 WebSocket reconnected - triggering bulk sync to catch up on missed changes');
          await loadNotes(true); // Force bulk sync to bypass duplicate prevention
        } catch (error) {
          console.error('Failed to sync after WebSocket reconnection:', error);
        }
      }, 1000);
    });
    
    webSocketManager.on('disconnected', () => {
      devLog('🔥 WebSocket disconnected');
      checkConnectionState(); // Update immediately
    });
    
    // Still poll periodically as backup, but less frequently
    const stateCheckInterval = setInterval(checkConnectionState, 5000); // Every 5 seconds as backup
    
    // Also check immediately on setup
    checkConnectionState();
    
    return () => {
      clearInterval(stateCheckInterval);
      webSocketManager.off('connected', checkConnectionState);
      webSocketManager.off('disconnected', checkConnectionState);
    };
  };

  // Simplified WebSocket event listeners
  const setupWebSocketEventListeners = () => {
    // Real-time note updates
    webSocketManager.on('note-updated', (data) => {
      devLog('📝 Real-time note update received:', data.noteId);
      
      // Ignore updates from the same connection to prevent echo
      const currentConnectionId = webSocketManager.getConnectionId();
      if (data.connectionId && data.connectionId === currentConnectionId) {
        devLog('🔄 Ignoring update from same connection to prevent boomerang conflicts');
        return;
      }
      
      let updatedNote = null;
      
      // Small delay to allow manual saves to complete first and avoid race conditions
      setTimeout(() => {
        // Update the specific note in our notes array
        setNotes(prevNotes => {
          return prevNotes.map(note => {
            if (note.id === data.noteId) {
              // Handle diff-based vs full content updates
              let newContent = note.content;
              
              if (data.updates.contentDiff) {
                try {
                  newContent = applyContentDiff(note.content, data.updates.contentDiff);
                  devLog('📦 [APP] Applied content diff to notes array:', {
                    patchCount: data.updates.contentDiff.length,
                    originalLength: note.content.length,
                    resultLength: newContent.length
                  });
                } catch (error) {
                  console.error('❌ [APP] Failed to apply content diff to notes array:', error);
                  // Fallback to existing content if diff fails
                  newContent = note.content;
                }
              } else if (data.updates.content !== undefined) {
                newContent = data.updates.content;
                devLog('📄 [APP] Full content update to notes array (legacy mode)');
              }
              
              updatedNote = {
                ...note,
                title: data.updates.title !== undefined ? data.updates.title : note.title,
                content: newContent,
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
        
        // Update selectedNote if it's the one being updated
        setSelectedNote(currentSelectedNote => {
          if (currentSelectedNote && currentSelectedNote.id === data.noteId && updatedNote) {
            return updatedNote;
          }
          return currentSelectedNote;
        });
        
        // Update timestamps
        setNotesTimestamps(prev => {
          const updated = new Map(prev);
          updated.set(data.noteId, new Date(data.timestamp || data.updatedAt).getTime());
          return updated;
        });

        // CRITICAL: Update offline cache with server data to maintain sync consistency
        if (updatedNote && user?.id) {
          offlineStorage.storeNote(updatedNote, user.id, { fromServer: true })
            .catch(error => {
              console.error(`Failed to update cache for real-time note ${data.noteId}:`, error);
            });
        }
      }, 100); // 100ms delay to avoid race conditions
    });

    // Presence changes
    webSocketManager.on('presence-changed', (data) => {
      // Handle presence updates if needed
    });

    // Join note success
    webSocketManager.on('join-note-success', (data) => {
      // Note collaboration joined
    });

    // Bulk sync responses
    webSocketManager.on('batch-saved', (data) => {
      // The batch-saved event is handled in the NoteEditor component
      // We don't need to update the notes array here as it causes feedback loops
      // The NoteEditor already handles the batch save confirmation and updates its internal state
    });
  };

  // Connection management is now handled entirely by ConnectionController

  // Start HTTP polling (fallback only)
  const startHttpPolling = () => {
    // Only start HTTP polling if WebSocket is not connected
    if (websocketConnected) {
      return;
    }

    // Don't start if we're in websocket mode (even if websocketConnected is false temporarily)
    if (connectionMode === 'websocket' || connectionMode === 'connecting') {
      return;
    }

    // Prevent multiple overlapping timers
    if (refreshIntervalId) {
      return;
    }

    // Rate limiting: don't start polling more than once every 5 seconds
    const now = Date.now();
    if (now - lastPollingStart < 5000) {
      return;
    }
    setLastPollingStart(now);
    
    const intervalId = setInterval(() => {
      // Only poll if WebSocket is not connected
      if (!websocketConnected) {
        checkForNoteUpdates(true);
      }
    }, 30000);
    
    setRefreshIntervalId(intervalId);
  };

  // Stop HTTP polling
  const stopHttpPolling = () => {
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
      setRefreshIntervalId(null);
    }
  };

  // ===== EXISTING HELPER FUNCTIONS =====
  
  const saveTemporaryNotesToStorage = (notes) => {
    const tempNotes = notes.filter(note => note.id.startsWith('temp_'));
    localStorage.setItem('tempNotes', JSON.stringify(tempNotes));
  };

  const loadTemporaryNotesFromStorage = () => {
    try {
      const saved = localStorage.getItem('tempNotes');
      if (saved) {
        const tempNotes = JSON.parse(saved);
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
      }
    } catch (error) {
      console.error('Failed to remove temporary note from localStorage:', error);
    }
  };

  // Enhanced note update handling (HTTP fallback only)
  const checkForNoteUpdates = async (silent = true) => {
    // Skip if WebSocket is handling updates
    if (websocketConnected) {
      return;
    }

    if (!user || !isOnline) {
      return;
    }
    
    try {
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
          }
        }
      });
      
      // Update notes if there are changes or if this is the first load
      if (hasUpdates || notesTimestamps.size === 0) {
        setNotes(allNotes);
        setNotesTimestamps(newTimestamps);
        
        // CRITICAL FIX: Update selected note if it was changed
        if (selectedNote) {
          const updatedSelectedNote = allNotes.find(note => note.id === selectedNote.id);
          if (updatedSelectedNote) {
            const selectedNoteTime = selectedNote.updatedAt ? new Date(selectedNote.updatedAt).getTime() : 0;
            const updatedNoteTime = updatedSelectedNote.updatedAt ? new Date(updatedSelectedNote.updatedAt).getTime() : 0;
            
            // Update if timestamps differ OR if we don't have updatedAt on selected note
            if (updatedNoteTime !== selectedNoteTime || !selectedNote.updatedAt) {
              setSelectedNote(updatedSelectedNote);
            }
          }
        }
      }
      
    } catch (error) {
      if (!silent) {
        console.error('Failed to check for note updates via HTTP:', error);
      }
    }
  };

  // Handle notes updated from WebSocket or bulk sync
  const handleNotesUpdated = async (updatedNotes) => {
    
    // CRITICAL: Apply conflict resolution for all updated notes
    // This prevents race conditions where offline devices overwrite server changes
    if (user && updatedNotes.length > 0) {
      const notesToUpdate = [];
      
      try {
        // Get current notes from state to compare against
        const currentNotesMap = new Map(notes.map(n => [n.id, n]));
        
        for (const note of updatedNotes) {
          const shouldDefer = await offlineStorage.shouldDeferToServer(note.id, note);
          if (shouldDefer) {
            // Check if this note is actually different from what we have in state
            const currentNote = currentNotesMap.get(note.id);
            const hasRealChanges = !currentNote || 
              currentNote.title !== note.title ||
              currentNote.content !== note.content ||
              currentNote.updatedAt !== note.updatedAt;
            
            if (hasRealChanges) {
              await offlineStorage.storeNote(note, user.id, { fromServer: true });
              notesToUpdate.push(note);
            } else {
              // Still update the cache hash but don't trigger UI update
              await offlineStorage.storeNote(note, user.id, { fromServer: true });
            }
          } else {
            // Update original hash but don't overwrite local content
            const cachedNote = await offlineStorage.getCachedNote(note.id);
            if (cachedNote && note.contentHash) {
              await offlineStorage.updateOriginalHashAfterSync(
                note.id, 
                note.contentHash, 
                note.content, 
                note.title
              );
            }
          }
        }
        
        // Only update React state for notes that were accepted from server
        if (notesToUpdate.length > 0) {
          updatedNotes = notesToUpdate;
        } else {
          updatedNotes = [];
        }
      } catch (error) {
        console.error('❌ Failed to apply conflict resolution:', error);
      }
    }
    
    // First, identify which note needs to be updated for selected note (BEFORE state update)
    const selectedNoteUpdate = selectedNote ? 
      updatedNotes.find(note => note.id === selectedNote.id) : null;
    
    // Update the notes state with the new data
    if (updatedNotes.length > 0) {
      setNotes(prevNotes => {
        const updatedNotesMap = new Map(updatedNotes.map(note => [note.id, note]));
        
        return prevNotes.map(note => {
          const updated = updatedNotesMap.get(note.id);
          if (updated) {
            return updated;
          }
          return note;
        });
      });
    }
    
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
    
    // CRITICAL FIX: Update selected note if it was affected
    if (selectedNoteUpdate) {
      setSelectedNote(selectedNoteUpdate);
    }
    
    setLastBulkSync(new Date());
  };

  // Enhanced loadNotes with proper conflict detection via syncService
  const loadNotes = async (forceBulkSync = false) => {
    // Prevent multiple parallel requests (unless forced for bulk sync)
    if (loadNotesInProgressRef.current && !forceBulkSync) {
      return;
    }
    
    loadNotesInProgressRef.current = true;
    try {
      // First get basic notes list
      const response = await api.get('/api/notes');
      const serverNotes = response.data || [];
      
      // Set bulk sync flag to prevent race condition conflicts
      setBulkSyncInProgress(true);
      
      // Run intelligent bulk sync with conflict detection
      const syncResult = await syncService.syncAllNotes(serverNotes, user);
      
      // Handle conflicts if any
      if (syncResult.conflicts.length > 0) {
        setConflicts(syncResult.conflicts);
        setShowConflictDialog(true);
      }
      
      // Apply non-conflicted updates
      const temporaryNotes = loadTemporaryNotesFromStorage();
      let allNotes = [...temporaryNotes, ...serverNotes];
      
      // Update notes with sync results (non-conflicted notes)
      if (syncResult.updatedNotes.length > 0) {
        
        // Store updated notes in cache with server flag
        for (const updatedNote of syncResult.updatedNotes) {
          await offlineStorage.storeNote(updatedNote, user.id, { fromServer: true });
        }
        
        // Update the notes array with sync results
        const updatedNoteIds = new Set(syncResult.updatedNotes.map(note => note.id));
        allNotes = allNotes.map(note => {
          if (updatedNoteIds.has(note.id)) {
            const updatedNote = syncResult.updatedNotes.find(u => u.id === note.id);
            return updatedNote || note;
          }
          return note;
        });
      }
      
      setNotes(allNotes);
      setErrorMessage('');
      
      // Handle selected note updates (non-conflicted only)
      if (selectedNote && syncResult.updatedNotes.length > 0) {
        const updatedSelectedNote = syncResult.updatedNotes.find(note => note.id === selectedNote.id);
        if (updatedSelectedNote) {
          setSelectedNote(updatedSelectedNote);
          
          // Trigger direct editor update
          if (window.noteEditorDirectUpdate) {
            window.noteEditorDirectUpdate({
              content: updatedSelectedNote.content,
              title: updatedSelectedNote.title,
              updatedAt: updatedSelectedNote.updatedAt
            });
          }
        }
      }
      
      // Set up timestamps for future comparison
      const timestamps = new Map();
      allNotes.forEach(note => {
        if (note.updatedAt) {
          timestamps.set(note.id, new Date(note.updatedAt).getTime());
        }
      });
      setNotesTimestamps(timestamps);
      
    } catch (error) {
      console.error('Failed to load notes with sync:', error);
      
      // Fallback to basic loading
      try {
        const response = await api.get('/api/notes');
        const serverNotes = response.data || [];
        const temporaryNotes = loadTemporaryNotesFromStorage();
        const allNotes = [...temporaryNotes, ...serverNotes];
        
        setNotes(allNotes);
      } catch (fallbackError) {
        console.error('Fallback loading also failed:', fallbackError);
        
        const temporaryNotes = loadTemporaryNotesFromStorage();
        if (temporaryNotes.length > 0) {
          setNotes(temporaryNotes);
        }
      }
      
      // Show specific error messages for certain conditions
      if (error.response?.status === 429) {
        setErrorMessage('Server is busy (rate limited). Your notes will load when the limit resets.');
      } else if (!api.isNetworkError(error) && isOnline) {
        setErrorMessage('Failed to load notes. Please try again.');
      }
    } finally {
      loadNotesInProgressRef.current = false;
      setBulkSyncInProgress(false); // Clear bulk sync flag to re-enable conflict detection
    }
  };

  const syncTemporaryNotes = async () => {
    // Prevent multiple parallel sync operations
    if (syncInProgressRef.current) {
      return;
    }
    
    syncInProgressRef.current = true;
    
    const temporaryNotes = loadTemporaryNotesFromStorage();
    
    if (temporaryNotes.length === 0) {
      syncInProgressRef.current = false;
      return;
    }
    
    setSyncInProgress(true);
    
    for (const tempNote of temporaryNotes) {
      try {
        const response = await api.post('/api/notes', {
          title: tempNote.title || '',
          content: tempNote.content || ''
        });
        
        const serverNote = response.data;
        
        setNotes(prevNotes => {
          const updatedNotes = prevNotes.map(note => 
            note.id === tempNote.id ? serverNote : note
          );
          return updatedNotes;
        });
        
        setSelectedNote(prevSelected => {
          if (prevSelected && prevSelected.id === tempNote.id) {
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
        
      } catch (error) {
        console.error(`Failed to sync temporary note ${tempNote.id}:`, error);
      }
    }
    
    setSyncInProgress(false);
    syncInProgressRef.current = false;
  };

  // Simplified offline listeners - let ConnectionController handle everything
  const setupOfflineListeners = () => {
    const handleBrowserOnline = async () => {
      console.log('🌐 Browser detected: online');
      setIsOnline(true);
      setRetryCount(0);
      setErrorMessage('');
      
      // Update ConnectionController online state - let it handle the connection
      connectionController.setOnline(true, 'browser online event');
      
      // Just sync data - connection is handled by ConnectionController
      setTimeout(async () => {
        try {
          await syncTemporaryNotes();
          await loadNotes();
        } catch (error) {
          console.error('❌ Failed to sync after coming online:', error);
        }
      }, 1000);
    };

    const handleBrowserOffline = () => {
      console.log('📱 Browser detected: offline');
      setIsOnline(false);
      
      // Update ConnectionController offline state - let it handle disconnection
      connectionController.setOnline(false, 'browser offline event');
    };

    // Simplified visibility change handler
    const handleVisibilityChange = () => {
      setAppVisibility(document.visibilityState);
      
      if (document.visibilityState === 'visible') {
        console.log('👁️ App became visible');
        connectionController.onAppResume();
      } else {
        console.log('😴 App became hidden');
        connectionController.onAppPause();
      }
    };

    // Simplified focus handlers
    const handleFocus = () => {
      console.log('🔍 Window focused');
      connectionController.onAppResume();
    };

    const handleBlur = () => {
      console.log('😴 Window blurred');
      connectionController.onAppPause();
    };

    // Set up event listeners
    window.addEventListener('online', handleBrowserOnline);
    window.addEventListener('offline', handleBrowserOffline);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Set initial states
    setIsOnline(navigator.onLine);
    setAppVisibility(document.visibilityState);
    
    // Initialize ConnectionController online state
    connectionController.setOnline(navigator.onLine, 'initial setup');

    // API event listeners - simplified
    api.addEventListener('online', async () => {
      console.log('🔗 API detected: online');
      setIsOnline(true);
      setRetryCount(0);
      setErrorMessage('');
      
      connectionController.setOnline(true, 'API online event');
      
      setTimeout(async () => {
        try {
          await syncTemporaryNotes();
          await loadNotes();
        } catch (error) {
          console.error('Failed to sync after API online:', error);
        }
      }, 1000);
    });
    
    api.addEventListener('offline', () => {
      console.log('🔗 API detected: offline');
      setIsOnline(false);
      
      connectionController.setOnline(false, 'API offline event');
    });
    
    api.addEventListener('sync-start', () => setSyncInProgress(true));
    api.addEventListener('sync-complete', () => {
      setSyncInProgress(false);
      setRetryCount(0);
      setErrorMessage(''); // Clear any sync-related error messages on successful sync
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
      // Check if this is a WebSocket save confirmation (not a new save request)
      const isWebSocketSaveConfirmation = updates._isWebSocketSaveConfirmation;
      if (isWebSocketSaveConfirmation) {
        console.log(`🔄 Processing WebSocket save confirmation for note ${id}`);
        
        // Clean the updates object
        const cleanUpdates = { ...updates };
        delete cleanUpdates._isWebSocketSaveConfirmation;
        
        // Update notes array and selectedNote with the confirmed save data
        setNotes(prevNotes => {
          console.log(`🔄 WebSocket save confirmation updating note ${id} in notes list with timestamp:`, cleanUpdates.updatedAt);
          return prevNotes.map(note => note.id === id ? { ...note, ...cleanUpdates, offline: false, pendingSync: false } : note);
        });
        
        if (selectedNote && selectedNote.id === id) {
          setSelectedNote(prev => {
            console.log(`🔄 WebSocket save confirmation updating selected note ${id} with timestamp:`, cleanUpdates.updatedAt);
            return { ...prev, ...cleanUpdates, offline: false, pendingSync: false };
          });
        }
        
        // Update timestamps
        setNotesTimestamps(prev => {
          const updated = new Map(prev);
          updated.set(id, new Date(cleanUpdates.updatedAt).getTime());
          console.log(`🕒 WebSocket save confirmation updated timestamp for note ${id}:`, new Date(cleanUpdates.updatedAt).toLocaleString());
          return updated;
        });
        
        return; // Don't proceed with server save - this is just a confirmation
      }
      
      const isTemporaryNote = id.startsWith('temp_');
      
      if (isTemporaryNote) {
        const updatedNote = {
          ...notes.find(note => note.id === id),
          ...updates,
          updatedAt: new Date().toISOString(),
          offline: true,
          pendingSync: true
        };
        
        setNotes(prevNotes => {
          console.log(`🔄 Temp note update for note ${id} in notes list with timestamp:`, updatedNote.updatedAt);
          const newNotes = prevNotes.map(note => note.id === id ? updatedNote : note);
          saveTemporaryNotesToStorage(newNotes);
          return newNotes;
        });
        
        if (selectedNote && selectedNote.id === id) {
          setSelectedNote(updatedNote);
          console.log(`🔄 Temp note update for selected note ${id} with timestamp:`, updatedNote.updatedAt);
        }
        
        console.log('Updated temporary note locally:', id);
        return;
      }
      
      // CRITICAL: Update cache BEFORE server save to preserve changes if network fails
      if (user?.id) {
        const currentNote = notes.find(note => note.id === id);
        if (currentNote) {
          const updatedNoteForCache = {
            ...currentNote,
            ...updates,
            updatedAt: new Date().toISOString(), // Temporary timestamp, will be replaced by server response
          };
          
          try {
            await offlineStorage.storeNote(updatedNoteForCache, user.id);
            console.log(`💾 Cache updated BEFORE server save for note ${id}`);
          } catch (cacheError) {
            console.error(`❌ Failed to update cache before save for note ${id}:`, cacheError);
            // Continue with server save even if cache fails
          }
        }
      }
      
      const response = await api.put(`/api/notes/${id}`, updates);
      const updatedNote = response.data;
      
      // CRITICAL: Update cache AFTER successful server save with final server data
      if (user?.id) {
        try {
          await offlineStorage.storeNote(updatedNote, user.id, { fromServer: true });
          console.log(`💾 Cache updated AFTER successful server save for note ${id}`);
        } catch (cacheError) {
          console.error(`❌ Failed to update cache after server save for note ${id}:`, cacheError);
        }
      }
      
      // Use functional update to ensure we're working with latest state
      // Update notes list and selected note simultaneously to prevent sync issues
      setNotes(prevNotes => {
        console.log(`🔄 Manual save updating note ${id} in notes list with timestamp:`, updatedNote.updatedAt);
        return prevNotes.map(note => note.id === id ? updatedNote : note);
      });
      
      // Update selected note immediately after notes array
      if (selectedNote && selectedNote.id === id) {
        setSelectedNote(updatedNote);
        console.log(`🔄 Manual save updating selected note ${id} with timestamp:`, updatedNote.updatedAt);
      }
      
      // Update timestamps
      setNotesTimestamps(prev => {
        const updated = new Map(prev);
        updated.set(updatedNote.id, new Date(updatedNote.updatedAt).getTime());
        console.log(`🕒 Manual save updated timestamp for note ${id}:`, new Date(updatedNote.updatedAt).toLocaleString());
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
        
        setNotes(prevNotes => {
          console.log(`🔄 Network error save updating note ${id} in notes list with timestamp:`, updatedNote.updatedAt);
          return prevNotes.map(note => note.id === id ? updatedNote : note);
        });
        
        if (selectedNote && selectedNote.id === id) {
          setSelectedNote(updatedNote);
          console.log(`🔄 Network error save updating selected note ${id} with timestamp:`, updatedNote.updatedAt);
        }
        
        if (id.startsWith('temp_')) {
          // Re-fetch notes for temp note storage after state update
          setTimeout(() => {
            const currentNotes = notes.map(note => note.id === id ? updatedNote : note);
            saveTemporaryNotesToStorage(currentNotes);
          }, 0);
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
    const cleanupConnectionController = setupConnectionControllerListeners();
    
    return () => {
      if (cleanupOfflineListeners) {
        cleanupOfflineListeners();
      }
      if (cleanupConnectionController) {
        cleanupConnectionController();
      }
      stopHttpPolling();
      
      // Clear HTTP fallback timeout
      if (httpFallbackTimeoutRef.current) {
        clearTimeout(httpFallbackTimeoutRef.current);
        httpFallbackTimeoutRef.current = null;
      }
      
      // Cleanup WebSocket
      webSocketManager.disconnect();
    };
  }, []);

  // Setup ConnectionController when user changes
  useEffect(() => {
    if (user) {
      console.log('🔌 User authenticated, setting up ConnectionController...');
      
      // Setup WebSocket event listeners once
      setupWebSocketEventListeners();
      
      // Always update ConnectionController, but don't disconnect/reconnect if already connected
      const token = localStorage.getItem('token');
      const currentState = connectionController.getState();
      
      if (!currentState.hasUser || user.isMinimal) {
        // First time setting user or upgrading from minimal user
        console.log('🔄 Setting/upgrading user in ConnectionController');
        connectionController.setUser(user, token);
        connectionController.setOnline(navigator.onLine, 'user authenticated');
      } else {
        console.log('🔄 User already connected, maintaining connection');
      }
    } else {
      // Clear user from ConnectionController
      connectionController.setUser(null, null);
    }
  }, [user]);
  
  // Note: WebSocket event listeners are now set up in setupWebSocketEventListeners()

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
      let payload;
      try {
        payload = JSON.parse(atob(token.split('.')[1]));
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
        
        // WebSocket connection handled by ConnectionController after user is set
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
    webSocketManager.disconnect();
    
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
    webSocketManager.disconnect();
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
      case 'websocket': return 'Connected';
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
                bulkSyncInProgress={bulkSyncInProgress}
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
      
      {/* Conflict Resolution Dialog */}
      <Dialog 
        open={showConflictDialog} 
        onClose={() => setShowConflictDialog(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <WarningIcon color="warning" />
            Sync Conflict Detected
          </Box>
        </DialogTitle>
        <DialogContent>
          {conflicts.length > 0 && (
            <>
              <Typography variant="body1" gutterBottom>
                Changes were made to the same note on different devices. Please choose which version to keep:
              </Typography>
              {conflicts.map((conflict, index) => (
                <Box key={conflict.noteId} sx={{ mt: 2, p: 2, border: '1px solid #ddd', borderRadius: 1 }}>
                  <Typography variant="h6" gutterBottom>
                    Note: {conflict.serverTitle || 'Untitled'}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="subtitle2" color="primary">Local Version</Typography>
                      <Typography variant="body2" sx={{ 
                        maxHeight: 100, 
                        overflow: 'auto', 
                        p: 1, 
                        bgcolor: '#f5f5f5',
                        borderRadius: 1
                      }}>
                        {conflict.localContent?.substring(0, 200)}...
                      </Typography>
                    </Box>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="subtitle2" color="secondary">Server Version</Typography>
                      <Typography variant="body2" sx={{ 
                        maxHeight: 100, 
                        overflow: 'auto', 
                        p: 1, 
                        bgcolor: '#f5f5f5',
                        borderRadius: 1
                      }}>
                        {conflict.serverContent?.substring(0, 200)}...
                      </Typography>
                    </Box>
                  </Box>
                </Box>
              ))}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => {
            // Keep local versions
            setShowConflictDialog(false);
            setConflicts([]);
            console.log('✅ User chose to keep local versions');
          }}>
            Keep Local Changes
          </Button>
          <Button onClick={() => {
            // Accept server versions
            setShowConflictDialog(false);
            setConflicts([]);
            console.log('✅ User chose to accept server versions');
            // TODO: Implement server version acceptance
          }} variant="contained">
            Use Server Changes
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
