import React, { useState, useEffect, useCallback, useRef } from 'react';
import fastDiff from 'fast-diff';
import {
  Box,
  TextField,
  Paper,
  Typography,
  Chip,
  IconButton,
  Alert,
  Tooltip,
  AppBar,
  Toolbar,
  Divider,
  ButtonGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  CircularProgress,
  LinearProgress,
  Avatar,
  AvatarGroup,
  Collapse
} from '@mui/material';
import {
  Share as ShareIcon,
  Lock as LockIcon,
  LockOpen as LockOpenIcon,
  People as PeopleIcon,
  Warning as WarningIcon,
  ArrowBack as ArrowBackIcon,
  Save as SaveIcon,
  FormatBold as BoldIcon,
  FormatItalic as ItalicIcon,
  FormatUnderlined as UnderlineIcon,
  FormatStrikethrough as StrikethroughIcon,
  CheckBox as CheckboxIcon,
  FormatListBulleted as BulletIcon,
  FormatListNumbered as NumberIcon,
  FormatQuote as QuoteIcon,
  Code as CodeIcon,
  Link as LinkIcon,
  Undo as UndoIcon,
  Redo as RedoIcon,
  Image as ImageIcon,
  CloudUpload as UploadIcon,
  Sync as SyncIcon,
  ExpandLess as ExpandLessIcon,
  ExpandMore as ExpandMoreIcon,
  Refresh as RefreshIcon,
  Close as CloseIcon,
  Wifi as WifiIcon,
  WifiOff as WifiOffIcon,
  FlashOn as RealtimeIcon
} from '@mui/icons-material';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import DropCursor from '@tiptap/extension-dropcursor';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import api from '../utils/api';
import ShareNoteDialog from './ShareNoteDialog';
import { syncService, ConflictResolutionStrategies } from '../services/syncService';
import { useAppLifecycle } from '../hooks/useAppLifecycle';
import webSocketManager from '../services/WebSocketManager';
import offlineStorage from '../utils/offlineStorage';

// Enhanced import testing for diff system
let diffSystemWorking = false;
try {
  // Test the diff functionality
  const testOld = 'Hello World';
  const testNew = 'Hello Beautiful World';
  const testDiff = fastDiff(testOld, testNew);
  
  if (testDiff && Array.isArray(testDiff)) {
    diffSystemWorking = true;
    console.log('✅ [DIFF] fast-diff library loaded and tested successfully:', {
      testDiff: testDiff.length + ' operations',
      diffSystemWorking: true
    });
  } else {
    console.error('❌ [DIFF] fast-diff loaded but functionality test failed');
  }
} catch (error) {
  console.error('❌ [DIFF] Failed to load fast-diff library:', error);
  console.log('📄 [DIFF] Will use legacy full-content mode only');
}

// Global flag to track diff system availability
window.DIFF_SYSTEM_STATUS = {
  available: diffSystemWorking,
  library: !!fastDiff,
  tested: diffSystemWorking
};

// Development logging utility
const isDevelopment = process.env.NODE_ENV === 'development';
const devLog = (...args) => {
  if (isDevelopment) {
    console.log(...args);
  }
};


// Utility function to normalize content for comparison
// Prevents ghost saves from minor whitespace/encoding differences
const normalizeContent = (content) => {
  if (!content) return '';
  return content
    .replace(/\r\n/g, '\n')           // Normalize line endings (Windows)
    .replace(/\r/g, '\n')            // Handle old Mac line endings  
    .replace(/\s+$/g, '')            // Remove trailing whitespace
    .replace(/(<p><\/p>)+$/g, '')    // Remove trailing empty paragraphs
    .trim();                         // Remove leading/trailing whitespace
};

const NoteEditor = ({ 
  note, 
  onUpdateNote, 
  onBack, 
  isMobile = false, 
  currentUser,
  notes = [],                    // Array of all notes for bulk sync
  onNotesUpdated,              // Callback when bulk sync updates notes
  websocketConnected = false,  // NEW: WebSocket connection status from App.js
  connectionMode = 'http',     // NEW: Connection mode from App.js
  bulkSyncInProgress = false   // NEW: Bulk sync in progress flag to prevent false conflicts
}) => {
  // ===== STATE DECLARATIONS =====
  const [title, setTitle] = useState('');
  const [lastSaved, setLastSaved] = useState(null);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [lockOwner, setLockOwner] = useState(null);
  const [lockError, setLockError] = useState('');
  const [lastSaveTime, setLastSaveTime] = useState(null); // Track when we last saved to suppress rapid conflict dialogs
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(() => {
    // Remember user's preference
    const saved = localStorage.getItem('noteEditorToolbarExpanded');
    return saved ? JSON.parse(saved) : false;
  }); 

  // Image upload states
  const [imageUploadDialog, setImageUploadDialog] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  
  // Enhanced collaboration state with WebSocket
  const [activeEditors, setActiveEditors] = useState([]);
  const [hasRemoteChanges, setHasRemoteChanges] = useState(false);
  const [lastUpdateTimestamp, setLastUpdateTimestamp] = useState(null);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [pendingRemoteUpdate, setPendingRemoteUpdate] = useState(null);
  const [showCollaborationAlert, setShowCollaborationAlert] = useState(true);
  const [syncingChanges, setSyncingChanges] = useState(false);
  
  // NEW: WebSocket states
//  const [websocketConnected, setWebsocketConnected] = useState(false);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [lastRealtimeUpdate, setLastRealtimeUpdate] = useState(null);
  
  // Bulk sync states
  const [localBulkSyncInProgress, setLocalBulkSyncInProgress] = useState(false);
  const [lastBulkSync, setLastBulkSync] = useState(null);
  const [bulkSyncResults, setBulkSyncResults] = useState(null);
  const [appResumeSync, setAppResumeSync] = useState(false);

  // ===== REF DECLARATIONS =====
  const currentNoteId = useRef(null);
  const initialValues = useRef({ title: '', content: '' });
  const saveTimeoutRef = useRef(null);
  const lockTimeoutRef = useRef(null);
  const lockExtensionIntervalRef = useRef(null);
  const lockPollingIntervalRef = useRef(null);
  const lockStateRef = useRef({ isLocked: false });
  const editorReadyRef = useRef(false);
  const userInteractedRef = useRef(false);
  const recentCheckboxInteractionRef = useRef(0); // Timestamp of last checkbox interaction
  const lastKnownScrollPositionRef = useRef(0); // Track the last known scroll position
  const fileInputRef = useRef(null);
  const dragCounterRef = useRef(0);
  const lastLocalUpdateRef = useRef(null);
  const applyingRemoteChangesRef = useRef(false);
  const noteTimestampRef = useRef(null);
  
  // NEW: WebSocket refs
  const websocketInitializedRef = useRef(false);
  const realtimeUpdateTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  
  // Legacy polling refs (fallback when WebSocket unavailable)
  const pollIntervalRef = useRef(null);
  const presenceIntervalRef = useRef(null);
  const sharedNotePollIntervalRef = useRef(null);
  const collaborationActiveRef = useRef(false);
  
  // Bulk sync refs
  const bulkSyncTimeoutRef = useRef(null);
  const lastBulkSyncTimeRef = useRef(null);
  const recentBulkSyncRef = useRef(null); // Track recent bulk sync completion timestamp

  // ===== WEBSOCKET INTEGRATION =====
  
  // Use WebSocket connection status from parent App.js
  const isWebSocketActive = websocketConnected && connectionMode === 'websocket';
  
  // Initialize WebSocket connection (only if not already handled by App.js)
  const initializeWebSocket = useCallback(async () => {
    // App.js handles WebSocket initialization, so we just connect to existing service
    if (!webSocketManager.getState().connected && websocketConnected) {
      console.log('⚠️ WebSocket should be active but service not ready');
      return;
    }

    if (isWebSocketActive) {
      console.log('✅ WebSocket active via App.js');
     // setWebsocketConnected(true);
      setConnectionStatus('connected');
      
      // Stop any legacy polling since WebSocket is active
      stopLegacyPolling();
    } else {
      console.log('📡 WebSocket not active, using HTTP fallback');
      //setWebsocketConnected(false);
      setConnectionStatus('http-fallback');
    }
  }, [isWebSocketActive, websocketConnected]);

  // Setup WebSocket event listeners
  const setupWebSocketListeners = useCallback(() => {
    if (!webSocketManager || !isWebSocketActive) return;

    // Note: App.js handles most WebSocket events, we just handle note-specific ones

    webSocketManager.on('note-updated', (data) => {
      // Only handle if this is for our current note
      if (data.noteId === currentNoteId.current) {
        console.log('📝 Real-time update for current note:', {
          noteId: data.noteId,
          fromUser: data.editor?.name || 'Unknown',
          hasUpdates: !!data.updates,
          timestamp: data.timestamp
        });
        
        handleRealtimeNoteUpdate(data);
      }
    });

    // Listen for batch save confirmations from server
    webSocketManager.on('batch-saved', (data) => {
      if (data.noteId === currentNoteId.current) {
        console.log('✅ Batch save confirmation received:', {
          noteId: data.noteId,
          savedAt: data.savedAt,
          batchId: data.batchId,
          updateCount: data.updateCount
        });
        
        // Clear pending status since server has confirmed save
        syncService.clearNotePending(data.noteId);
        
        // CRITICAL: Update initialValues immediately to prevent race condition with checkForChanges
        if (editor) {
          const currentContent = editor.getHTML();
          const currentTitle = title || note?.title || '';
          
          // Update initialValues synchronously so checkForChanges returns false immediately
          initialValues.current = {
            title: currentTitle,
            content: currentContent
          };
          console.log(`🔄 Updated initialValues after server confirmation to prevent orange indicator race condition`);
          
          // CRITICAL: Notify App.js about the successful WebSocket save so it can update the notes array
          if (onUpdateNote && note) {
            console.log(`📤 Notifying App.js about WebSocket save completion for note ${data.noteId}`);
            // Call the update callback with the current editor content and new timestamp
            onUpdateNote(data.noteId, {
              title: currentTitle,
              content: currentContent,
              updatedAt: data.savedAt,
              // This is a WebSocket save confirmation, not a new save request
              _isWebSocketSaveConfirmation: true
            });
          }
          
          // Note: originalHash will be updated by bulk sync when server broadcasts the change
          // No need to update it here to avoid hash feedback loops
        }
        
        // CRUCIAL: Also update React component state to hide orange indicator
        setHasUnsavedChanges(false);
        setLastSaved(new Date());
        setLastSaveTime(Date.now()); // Track save time to suppress rapid conflict dialogs
        
        // CRITICAL: Release the note lock after successful save but with delay to prevent race conditions
        // Use a timeout to access the current state values and avoid dependency issues
        setTimeout(() => {
          const currentIsLocked = lockStateRef.current?.isLocked;
          if (currentIsLocked) {
            console.log(`🔓 Releasing lock after successful save for note ${data.noteId}`);
            
            // Clear lock extension first to prevent conflicts
            if (lockExtensionIntervalRef.current) {
              clearInterval(lockExtensionIntervalRef.current);
              lockExtensionIntervalRef.current = null;
            }
            
            // Call releaseLock directly
            fetch(`${api.baseURL}/api/notes/${data.noteId}/lock`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
                'Content-Type': 'application/json'
              },
              credentials: 'include'
            }).catch(err => {
              if (!err.message.includes('ERR_INTERNET_DISCONNECTED')) {
                console.error('Failed to release lock:', err);
              }
            });
            
            // Update state
            setIsLocked(false);
            setLockOwner(null);
            setLockError('');
            
            // Clear lock timeout since we're releasing manually
            if (lockTimeoutRef.current) {
              clearTimeout(lockTimeoutRef.current);
              lockTimeoutRef.current = null;
            }
          }
        }, 100);
        
        console.log(`🔄 Cleared pending status and UI indicator for note ${data.noteId} after server confirmation`);
      }
    });

    webSocketManager.on('presence-changed', (data) => {
      if (data.noteId === currentNoteId.current) {
        console.log('👥 Presence changed for current note:', data);
        
        // Filter out current user's connections and add debugging
        const allEditors = data.activeEditors || [];
        const currentUserId = currentUser?.id;
        const currentConnectionId = webSocketManager.getConnectionId();
        
        console.log('🔍 Filtering active editors:', {
          allEditors,
          currentUserId,
          currentConnectionId,
          currentUserEmail: currentUser?.email
        });
        
        // Group by user ID to handle multiple connections per user (including stale ones)
        const userGroups = new Map();
        allEditors.forEach(editor => {
          const userId = editor.userId;
          if (!userGroups.has(userId)) {
            userGroups.set(userId, []);
          }
          userGroups.get(userId).push(editor);
        });
        
        console.log('👥 Grouped editors by user:', Object.fromEntries(userGroups));
        
        // Only show users who are different from current user (regardless of connection count)
        const otherUserGroups = Array.from(userGroups.entries())
          .filter(([userId, connections]) => userId !== currentUserId)
          .map(([userId, connections]) => {
            // Use the most recent connection for display (last one in array)
            const latestConnection = connections[connections.length - 1];
            return {
              ...latestConnection,
              connectionCount: connections.length
            };
          });
        
        const otherEditors = otherUserGroups;
        
        console.log('👥 Other editors after filtering:', otherEditors.map(editor => ({
          name: editor.name,
          email: editor.email,
          userId: editor.userId,
          connectionId: editor.connectionId
        })));
        setActiveEditors(otherEditors);
        
        // Hide collaboration alert if no other editors
        if (otherEditors.length === 0) {
          console.log('🚫 No other editors - hiding collaboration alert');
          setShowCollaborationAlert(false);
        }
      }
    });

    webSocketManager.on('note-joined', (data) => {
      if (data.noteId === currentNoteId.current) {
        console.log('✅ Joined note collaboration via WebSocket:', data.noteId);
        setRealtimeEnabled(true);
        
        // Filter out current user's connections for join event
        const allEditors = data.activeEditors || [];
        const currentUserId = currentUser?.id;
        const currentConnectionId = webSocketManager.getConnectionId();
        
        const otherEditors = allEditors.filter(editor => {
          const isDifferentUser = editor.userId !== currentUserId;
          const isDifferentConnection = editor.connectionId !== currentConnectionId;
          return isDifferentUser || isDifferentConnection;
        });
        
        console.log('✅ Active editors on join (filtered):', otherEditors);
        setActiveEditors(otherEditors);
      }
    });

  }, [isWebSocketActive, currentUser?.id]);

  // Handle real-time note updates from WebSocket
  const handleRealtimeNoteUpdate = useCallback((data) => {
    if (!data || !data.updates || !isWebSocketActive) return;
    
    // Enhanced boomerang detection to prevent false conflicts in single-user editing
    const currentConnectionId = webSocketManager.getConnectionId();
    const currentUserId = currentUser?.id;
    const updateFromSameConnection = data.connectionId && data.connectionId === currentConnectionId;
    const updateFromSameUser = data.editor?.id && data.editor.id === currentUserId;
    const isRecentUserSave = lastLocalUpdateRef.current && (Date.now() - lastLocalUpdateRef.current) < 10000; // 10 second window
    
    console.log('📡 [CLIENT] Received note-updated broadcast:', {
      noteId: data.noteId,
      fromConnectionId: data.connectionId,
      currentConnectionId: currentConnectionId,
      fromUserId: data.editor?.id,
      currentUserId: currentUserId,
      isBoomerangConnection: updateFromSameConnection,
      isBoomerangUser: updateFromSameUser,
      isRecentUserSave: isRecentUserSave,
      timestamp: new Date().toISOString()
    });
    
    // Ignore updates from same connection OR same user within recent save window
    if (updateFromSameConnection) {
      console.log('🔄 [BOOMERANG] Ignoring update from same WebSocket connection');
      return;
    }
    
    if (updateFromSameUser && isRecentUserSave) {
      console.log('🔄 [BOOMERANG] Ignoring update from same user within recent save window (preventing false conflict)');
      return;
    }
    
    console.log('📝 Processing real-time update:', {
      noteId: data.noteId,
      editor: data.editor?.name,
      hasTitle: !!data.updates.title,
      hasContent: !!data.updates.content,
      hasContentDiff: !!data.updates.contentDiff,
      isDiffBased: !!data.updates.contentDiff,
      timestamp: data.timestamp
    });
    
    // Check if this is for the current note
    if (data.noteId !== currentNoteId.current) {
      console.log('⭐ Update for different note, ignoring');
      return;
    }
    
    // Prevent conflicts during local edits
    const timeSinceLocalUpdate = lastLocalUpdateRef.current ? Date.now() - lastLocalUpdateRef.current : Infinity;
    if (timeSinceLocalUpdate < 2000) { // 2 seconds
      console.log('⏰ Recent local update, deferring real-time update');
      
      // Defer the update
      if (realtimeUpdateTimeoutRef.current) {
        clearTimeout(realtimeUpdateTimeoutRef.current);
      }
      
      realtimeUpdateTimeoutRef.current = setTimeout(() => {
        handleRealtimeNoteUpdate(data);
      }, 3000);
      return;
    }
    
    // Check for local changes before applying
    const hasLocalChanges = checkForChanges();
    
    if (hasLocalChanges) {
      // CRITICAL: Double-check for actual content differences to prevent false positives
      const currentContent = getCurrentContent();
      const currentTitle = title || '';
      const incomingTitle = data.updates.title || '';
      
      let incomingContent = '';
      let contentActuallyDiffers = false;
      
      // Handle diff-based vs full content updates
      if (data.updates.contentDiff) {
        // Apply diff to current content to get incoming content
        try {
          incomingContent = applyContentDiff(currentContent, data.updates.contentDiff);
          contentActuallyDiffers = currentContent !== incomingContent;
          devLog('📦 Applied content diff:', {
            patchCount: data.updates.contentDiff.length,
            currentLength: currentContent.length,
            resultLength: incomingContent.length,
            actuallyDiffers: contentActuallyDiffers
          });
        } catch (error) {
          console.error('❌ Failed to apply content diff:', error);
          devLog('❌ Diff application failed, using fallback to full content');
          // Fallback to existing content if diff fails
          incomingContent = currentContent;
          contentActuallyDiffers = false;
        }
      } else if (data.updates.content !== undefined) {
        // Traditional full content update
        incomingContent = data.updates.content || '';
        contentActuallyDiffers = currentContent !== incomingContent;
        devLog('📄 Processing full content update (legacy mode)');
      }
      
      const titleActuallyDiffers = currentTitle !== incomingTitle;
      
      // Check if we recently saved to suppress rapid conflict dialogs
      const timeSinceLastSave = lastSaveTime ? Date.now() - lastSaveTime : Infinity;
      const isInSaveGracePeriod = timeSinceLastSave < 4000; // 4 second grace period
      
      console.log('🔍 Double-checking real-time conflict detection:', {
        checkForChangesResult: hasLocalChanges,
        contentActuallyDiffers,
        titleActuallyDiffers,
        timeSinceLastSave,
        isInSaveGracePeriod,
        shouldShowConflict: (contentActuallyDiffers || titleActuallyDiffers) && !isInSaveGracePeriod
      });
      
      if ((contentActuallyDiffers || titleActuallyDiffers) && !isInSaveGracePeriod && !bulkSyncInProgress) {
        console.log('⚠️ Real changes detected - showing conflict dialog');
        setPendingRemoteUpdate({
          content: incomingContent,
          title: data.updates.title,
          updatedAt: data.timestamp,
          lastEditor: data.editor
        });
        setConflictDialogOpen(true);
      } else if (bulkSyncInProgress) {
        console.log('🔄 [BULK SYNC] Suppressing real-time conflict dialog during bulk sync operation');
        applyRemoteChanges({
          content: incomingContent,
          title: data.updates.title,
          updatedAt: data.timestamp
        }, ConflictResolutionStrategies.REPLACE);
      } else if ((contentActuallyDiffers || titleActuallyDiffers) && isInSaveGracePeriod) {
        console.log('🕐 Suppressing conflict dialog - in save grace period (recent save detected)');
        applyRemoteChanges({
          content: incomingContent,
          title: data.updates.title,
          updatedAt: data.timestamp
        }, ConflictResolutionStrategies.REPLACE);
      } else {
        console.log('✅ False positive conflict detected - applying real-time update without dialog');
        applyRemoteChanges({
          content: incomingContent,
          title: data.updates.title,
          timestamp: data.timestamp,
          editor: data.editor
        });
      }
    } else {
      console.log('✅ No local changes, applying real-time update');
      // Compute incoming content for no-conflict case as well
      let noConflictIncomingContent = '';
      if (data.updates.contentDiff) {
        try {
          const currentContent = getCurrentContent();
          noConflictIncomingContent = applyContentDiff(currentContent, data.updates.contentDiff);
          devLog('📦 Applied content diff (no conflict):', {
            patchCount: data.updates.contentDiff.length,
            currentLength: currentContent.length,
            resultLength: noConflictIncomingContent.length
          });
        } catch (error) {
          console.error('❌ Failed to apply content diff (no conflict):', error);
          noConflictIncomingContent = getCurrentContent(); // Fallback
        }
      } else if (data.updates.content !== undefined) {
        noConflictIncomingContent = data.updates.content || '';
        devLog('📄 Processing full content update (no conflict, legacy mode)');
      }
      
      applyRemoteChanges({
        content: noConflictIncomingContent,
        title: data.updates.title,
        updatedAt: data.timestamp,
        strategy: 'replace'
      });
      
      setHasRemoteChanges(true);
      setTimeout(() => setHasRemoteChanges(false), 2000);
    }
    
  }, [isWebSocketActive]);

  // NEW: Pause-based diff system refs
  const typingTimeoutRef = useRef(null);
  const saveStateRef = useRef({ canSave: true, pendingDiff: null });
  const stableBaselineRef = useRef('');
  const pendingChangesRef = useRef(false); // Track if changes occurred during save
  const [triggerQueuedSave, setTriggerQueuedSave] = useState(0); // State to trigger queued save
  const handleTypingPauseRef = useRef(); // Ref to avoid circular dependencies
  
  // Diff generation utilities with enhanced debugging
  const generateContentDiff = useCallback((oldContent, newContent) => {
    devLog('🔧 [DIFF] generateContentDiff called:', {
      oldLength: oldContent?.length || 0,
      newLength: newContent?.length || 0,
      contentsEqual: oldContent === newContent,
      fastDiffAvailable: typeof fastDiff !== 'undefined',
      oldPreview: oldContent?.substring(0, 50) + (oldContent?.length > 50 ? '...' : ''),
      newPreview: newContent?.substring(0, 50) + (newContent?.length > 50 ? '...' : '')
    });
    
    if (oldContent === newContent) {
      devLog('⚡ [DIFF] Contents identical, no diff needed');
      return null;
    }
    
    try {
      if (typeof fastDiff === 'undefined' || !diffSystemWorking) {
        console.error('❌ [DIFF] fast-diff library not available or not working, falling back to full content:', {
          libraryLoaded: typeof fastDiff !== 'undefined',
          systemWorking: diffSystemWorking,
          globalStatus: window.DIFF_SYSTEM_STATUS
        });
        return null; // This will trigger full content fallback
      }
      
      const diffs = fastDiff(oldContent, newContent);
      const patches = [];
      let position = 0;
      
      devLog('🧮 [DIFF] fast-diff generated operations:', diffs.length);
      
      for (const [operation, text] of diffs) {
        if (operation === fastDiff.INSERT) {
          patches.push({ op: 'insert', pos: position, text });
          devLog('➕ [DIFF] Insert at', position, ':', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
        } else if (operation === fastDiff.DELETE) {
          patches.push({ op: 'delete', pos: position, length: text.length });
          devLog('➖ [DIFF] Delete at', position, ', length:', text.length);
          position += text.length;
        } else {
          // EQUAL - move position forward
          position += text.length;
        }
      }
      
      devLog('📦 [DIFF] Generated patches:', {
        patchCount: patches.length,
        totalOperations: diffs.length,
        diffSize: JSON.stringify(patches).length,
        originalSize: newContent.length,
        efficiency: patches.length > 0 ? `${Math.round((1 - JSON.stringify(patches).length / newContent.length) * 100)}%` : 'N/A'
      });
      
      return patches.length > 0 ? patches : null;
    } catch (error) {
      console.error('❌ [DIFF] Error generating diff:', error);
      devLog('🔄 [DIFF] Falling back to full content due to error');
      return null; // This will trigger full content fallback
    }
  }, []);
  
  const applyContentDiff = useCallback((content, patches) => {
    if (!patches || patches.length === 0) return content;
    
    let result = content;
    // Apply patches in reverse order to maintain positions
    for (let i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch.op === 'insert') {
        result = result.slice(0, patch.pos) + patch.text + result.slice(patch.pos);
      } else if (patch.op === 'delete') {
        result = result.slice(0, patch.pos) + result.slice(patch.pos + patch.length);
      }
    }
    return result;
  }, []);

  // NEW: Pause-based diff calculation and save management
  const handleTypingPause = useCallback(async () => {
    if (!isWebSocketActive || !currentNoteId.current) {
      devLog('❌ [TYPING PAUSE] Save blocked - no WebSocket or noteId:', {
        isWebSocketActive,
        hasCurrentNoteId: !!currentNoteId.current
      });
      return;
    }

    // If a save is in progress, mark that we have pending changes and return
    if (!saveStateRef.current.canSave) {
      pendingChangesRef.current = true;
      devLog('⏳ [TYPING PAUSE] Save in progress, marking pending changes for next batch');
      return;
    }
    
    const currentContent = editor?.getHTML() || '';
    const baselineContent = stableBaselineRef.current;
    
    if (currentContent === baselineContent) {
      devLog('⚡ [TYPING PAUSE] No changes detected');
      return;
    }
    
    // Block new saves until this one completes
    saveStateRef.current.canSave = false;
    
    devLog('🔧 [TYPING PAUSE] Calculating diff after pause:', {
      baselineLength: baselineContent.length,
      currentLength: currentContent.length
    });
    
    const patches = generateContentDiff(baselineContent, currentContent);
    
    const updates = {
      mode: 'diff',
      contentDiff: patches,
      contentLength: currentContent.length,
      timestamp: Date.now()
    };
    
    if (!patches) {
      // Fall back to full content
      updates.mode = 'full';
      updates.content = currentContent;
      delete updates.contentDiff;
    }
    
    devLog('📡 [TYPING PAUSE] Sending update after pause:', updates);
    webSocketManager.sendNoteUpdate(currentNoteId.current, updates);
    
    // Store pending diff for rollback if needed
    saveStateRef.current.pendingDiff = { patches, originalBaseline: baselineContent };
    
  }, [isWebSocketActive, generateContentDiff]);
  
  // Update ref for circular dependency avoidance
  handleTypingPauseRef.current = handleTypingPause;
  
  // NEW: Handle typing events with pause-based timing
  const handleTypingEvent = useCallback(() => {
    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
    // Set new timeout for 1.5 seconds after typing stops
    typingTimeoutRef.current = setTimeout(() => {
      handleTypingPauseRef.current?.();
      typingTimeoutRef.current = null;
    }, 1500);
  }, []);
  
  // NEW: Handle server confirmation to update stable baseline
  const handleServerConfirmation = useCallback((confirmedContent) => {
    devLog('✅ [SERVER CONFIRM] Updating stable baseline after server confirmation:', {
      contentLength: confirmedContent.length,
      hasPendingChanges: pendingChangesRef.current
    });
    
    stableBaselineRef.current = confirmedContent;
    saveStateRef.current.canSave = true;
    saveStateRef.current.pendingDiff = null;
    
    // If there were changes made during the save, trigger another save
    if (pendingChangesRef.current) {
      pendingChangesRef.current = false;
      devLog('🔄 [SERVER CONFIRM] Triggering queued changes save');
      setTriggerQueuedSave(prev => prev + 1); // Trigger useEffect to handle queued save
    }
  }, []);
  
  // NEW: Handle queued saves after server confirmation
  useEffect(() => {
    if (triggerQueuedSave > 0) {
      const currentContent = editor?.getHTML() || '';
      const baselineContent = stableBaselineRef.current;
      
      if (currentContent !== baselineContent) {
        devLog('📋 [QUEUED SAVE] Content differs from baseline, processing queued changes');
        
        // Directly implement the typing timeout logic to avoid circular dependency
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
        }
        
        typingTimeoutRef.current = setTimeout(() => {
          handleTypingPauseRef.current?.();
          typingTimeoutRef.current = null;
        }, 1500);
      } else {
        devLog('📋 [QUEUED SAVE] No content changes detected');
      }
    }
  }, [triggerQueuedSave]);

  // Send real-time note update via WebSocket
  const sendRealtimeUpdate = useCallback((updates) => {
    devLog('🔍 [SEND DEBUG] Real-time update attempt:', {
      isWebSocketActive,
      websocketConnected,
      connectionMode,
      hasCurrentNoteId: !!currentNoteId.current,
      updates
    });
    
    // Title changes are immediate, content uses pause-based system
    if (updates.title !== undefined) {
      // Title changes should be immediate for better UX
      if (!isWebSocketActive || !currentNoteId.current) {
        devLog('❌ [SEND BLOCKED] Real-time update blocked:', {
          isWebSocketActive,
          hasCurrentNoteId: !!currentNoteId.current
        });
        return false;
      }
      
      devLog('📡 Sending immediate title update via WebSocket:', updates);
      return webSocketManager.sendNoteUpdate(currentNoteId.current, updates);
    } else {
      // Content updates now handled by pause-based system
      devLog('📡 Content update handled by pause-based diff system');
      return true;
    }
  }, [isWebSocketActive, websocketConnected, connectionMode]);

  // Start legacy HTTP polling (fallback only)
  const startLegacyPolling = useCallback(() => {
    // NEVER start HTTP polling if WebSocket is active
    if (isWebSocketActive) {
      console.log('⚠️ Skipping HTTP polling - WebSocket is active');
      return;
    }

    if (!note?.id || !(note.shared || note.hasBeenShared)) {
      return;
    }
    
    console.log('🔄 Starting legacy HTTP polling (WebSocket unavailable)');
    
    // Reduced from 45 seconds to 10 seconds for better responsiveness when WebSocket unavailable
    sharedNotePollIntervalRef.current = setInterval(() => {
      // Double-check WebSocket isn't active
      if (isWebSocketActive) {
        console.log('⚠️ WebSocket became active, stopping HTTP polling');
        stopLegacyPolling();
        return;
      }
      
      console.log('⏰ Legacy HTTP polling interval triggered');
      checkForUpdates();
      
      setTimeout(() => {
        checkActiveEditors();
      }, 2000);
    }, 10000); // 10 seconds for HTTP fallback
    
  }, [note?.id, note?.shared, note?.hasBeenShared, isWebSocketActive]);

  // Stop legacy HTTP polling
  const stopLegacyPolling = useCallback(() => {
    if (sharedNotePollIntervalRef.current) {
      console.log('🛑 Stopping legacy HTTP polling');
      clearInterval(sharedNotePollIntervalRef.current);
      sharedNotePollIntervalRef.current = null;
    }
    
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    
    collaborationActiveRef.current = false;
  }, []);

  // ===== APP LIFECYCLE INTEGRATION =====
  const handleAppResume = useCallback(async () => {
    console.log('📱 App resumed - checking WebSocket and triggering sync');
    
    // Force WebSocket reconnection if not connected
    if (!webSocketManager.getState().connected) {
      console.log('🔌 WebSocket disconnected, forcing reconnection after app resume');
      try {
        const token = localStorage.getItem('token');
        if (token) {
          await webSocketManager.forceReconnect(token);
        }
      } catch (error) {
        console.warn('⚠️ WebSocket reconnection failed:', error);
      }
    }
    
    // DEFERRED: Refresh current note AFTER other sync operations complete
    if (note?.id) {
      console.log('⚡ Scheduling note refresh after app resume (deferred to avoid race conditions)');
      setTimeout(async () => {
        try {
          // Wait for other sync operations to complete first
          console.log('🔄 Fetching latest note content from server (after sync delay)...');
          const response = await api.get(`/api/notes/${note.id}`);
          const latestNote = response.data;
          
          if (latestNote && latestNote.updatedAt !== note.updatedAt) {
            console.log('📝 Note was updated while app was backgrounded:', {
              currentTime: note.updatedAt,
              latestTime: latestNote.updatedAt,
              contentChanged: note.content !== latestNote.content,
              titleChanged: note.title !== latestNote.title
            });
            
            // Check if user has local changes
            const hasLocalChanges = checkForChanges();
            
            if (hasLocalChanges) {
              // CRITICAL: Double-check for actual content differences to prevent false positives
              const currentContent = getCurrentContent();
              const currentTitle = title || '';
              const contentActuallyDiffers = currentContent !== latestNote.content;
              const titleActuallyDiffers = currentTitle !== latestNote.title;
              
              // Check if we recently saved to suppress rapid conflict dialogs
              const timeSinceLastSave = lastSaveTime ? Date.now() - lastSaveTime : Infinity;
              const isInSaveGracePeriod = timeSinceLastSave < 4000; // 4 second grace period
              
              console.log('🔍 Double-checking bulk sync conflict detection:', {
                checkForChangesResult: hasLocalChanges,
                contentActuallyDiffers,
                titleActuallyDiffers,
                timeSinceLastSave,
                isInSaveGracePeriod,
                shouldShowConflict: (contentActuallyDiffers || titleActuallyDiffers) && !isInSaveGracePeriod
              });
              
              if ((contentActuallyDiffers || titleActuallyDiffers) && !isInSaveGracePeriod && !bulkSyncInProgress) {
                console.log('⚠️ Real changes detected - showing conflict dialog');
                setPendingRemoteUpdate({
                  content: latestNote.content,
                  title: latestNote.title,
                  updatedAt: latestNote.updatedAt,
                  lastEditor: { name: latestNote.lastEditorName || 'Unknown' }
                });
                setConflictDialogOpen(true);
              } else if (bulkSyncInProgress) {
                console.log('🔄 [BULK SYNC] Suppressing HTTP conflict dialog during bulk sync operation');
                applyRemoteChanges({
                  content: latestNote.content,
                  title: latestNote.title,
                  updatedAt: latestNote.updatedAt
                }, ConflictResolutionStrategies.REPLACE);
              } else if ((contentActuallyDiffers || titleActuallyDiffers) && isInSaveGracePeriod) {
                console.log('🕐 Suppressing conflict dialog - in save grace period (recent save detected)');
                applyRemoteChanges({
                  content: latestNote.content,
                  title: latestNote.title,
                  updatedAt: latestNote.updatedAt
                }, ConflictResolutionStrategies.REPLACE);
              } else {
                console.log('✅ False positive conflict detected - applying server changes without dialog');
                applyRemoteChanges({
                  content: latestNote.content,
                  title: latestNote.title,
                  timestamp: latestNote.updatedAt,
                  editor: { name: latestNote.lastEditorName || 'Unknown' }
                });
              }
            } else {
              console.log('✅ No local changes - applying server changes directly');
              applyRemoteChanges({
                content: latestNote.content,
                title: latestNote.title,
                updatedAt: latestNote.updatedAt
              });
            }
          } else {
            console.log('✅ Note is up to date after app resume');
          }
        } catch (error) {
          console.error('❌ Failed to refresh note after app resume:', error);
          // Fallback to heartbeat/incremental check
          if (webSocketManager.getState().connected) {
            webSocketManager.sendHeartbeat(note.id);
          } else {
            checkForUpdates();
          }
        }
      }, 3000); // Increased to 3 seconds to ensure all other sync operations complete first
    }
    
    if (!currentUser || !notes || notes.length === 0) {
      console.log('⭐ Skipping bulk sync - no user or notes');
      return;
    }
    
    setAppResumeSync(true);
    setLocalBulkSyncInProgress(true);
    
    try {
      console.log(`🔄 Starting bulk sync for ${notes.length} notes after app resume`);
      
      // Use WebSocket for bulk sync if available
      if (webSocketManager.getState().connected) {
        const noteTimestamps = {};
        notes.forEach(note => {
          if (note.updatedAt) {
            noteTimestamps[note.id] = note.updatedAt;
          }
        });
        
        webSocketManager.requestBulkSync(noteTimestamps);
        
        // Also run HTTP-based sync as backup
        setTimeout(async () => {
          const results = await syncService.syncAllNotes(notes, currentUser);
          handleBulkSyncResults(results);
        }, 2000);
        
      } else {
        // HTTP-only bulk sync
        const results = await syncService.syncAllNotes(notes, currentUser);
        handleBulkSyncResults(results);
      }
      
    } catch (error) {
      console.error('❌ Bulk sync failed:', error);
    } finally {
      setLocalBulkSyncInProgress(false);
      setAppResumeSync(false);
      // Set the timestamp for bulk sync completion
      recentBulkSyncRef.current = Date.now();
      console.log('🕒 Bulk sync completed, setting recentBulkSyncRef timestamp:', recentBulkSyncRef.current);
    }
  }, [currentUser, notes, onNotesUpdated, note?.id, note?.shared, note?.hasBeenShared, initializeWebSocket]);

  const handleBulkSyncResults = useCallback((results) => {
    console.log('✅ Bulk sync complete:', {
      updated: results.updatedNotes.length,
      conflicts: results.conflicts.length,
      errors: results.errors.length
    });
    
    setBulkSyncResults(results);
    setLastBulkSync(new Date());
    lastBulkSyncTimeRef.current = Date.now();
    
    // CRITICAL: Track bulk sync completion timestamp for timing-aware conflict resolution
    recentBulkSyncRef.current = Date.now();
    console.log('🕒 Setting recentBulkSyncRef timestamp:', recentBulkSyncRef.current);
    
    // Notify parent component of updates
    if (results.updatedNotes.length > 0 && onNotesUpdated) {
      console.log('🔥 Notifying App.js of bulk sync updates');
      onNotesUpdated(results.updatedNotes);
    }
    
    // Handle conflicts if any
    if (results.conflicts.length > 0) {
      console.log('⚠️ Conflicts detected during bulk sync:', results.conflicts.length);
      results.conflicts.forEach(conflict => {
        console.log('⚠️ Conflict in note:', conflict.note.id, conflict.note.title);
      });
    }
    
    // Clear results after a delay
    setTimeout(() => {
      setBulkSyncResults(null);
    }, 5000);
  }, [onNotesUpdated]);

  const handleAppBackground = useCallback(() => {
    console.log('📱 App backgrounded - maintaining WebSocket connection');
    // Keep WebSocket connected but reduce activity
    
    // Stop high-frequency polling
    stopLegacyPolling();
  }, [stopLegacyPolling]);

  // Use the app lifecycle hook
  useAppLifecycle(handleAppResume, handleAppBackground);

  // ===== EDITOR SETUP =====
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
        },
      }),
      Underline,
      TaskList.configure({
        HTMLAttributes: {
          class: 'tiptap-task-list',
        },
      }),
      TaskItem.configure({
        nested: true,
        HTMLAttributes: {
          class: 'tiptap-task-item',
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'tiptap-link',
        },
      }),
      Image.configure({
        HTMLAttributes: {
          class: 'tiptap-image',
        },
        allowBase64: true,
      }),
      DropCursor.configure({
        color: '#1976d2',
        width: 2,
      }),
    ],
    content: '',
    editable: true,
    onCreate: ({ editor }) => {
      // Inject CSS to prevent virtual keyboard on checkboxes AND force cursor visibility
      const style = document.createElement('style');
      style.id = 'checkbox-keyboard-prevention';
      style.textContent = `
        .tiptap-task-item input[type="checkbox"] {
          -webkit-user-select: none !important;
          -moz-user-select: none !important;
          user-select: none !important;
          touch-action: manipulation !important;
          -webkit-tap-highlight-color: transparent !important;
          -webkit-touch-callout: none !important;
          outline: none !important;
          pointer-events: auto !important;
        }
        .tiptap-task-item input[type="checkbox"]:focus {
          outline: none !important;
          box-shadow: none !important;
        }
        /* Force cursor to always be visible in the editor */
        .ProseMirror {
          caret-color: #1976d2 !important;
        }
        .ProseMirror .ProseMirror-selection {
          caret-color: #1976d2 !important;
        }
        /* Make cursor visible ONLY when editor is not focused */
        .ProseMirror:not(:focus)::after {
          content: "";
          position: absolute;
          width: 1px;
          height: 1em;
          background: #1976d2;
          animation: blink 1s infinite;
          pointer-events: none;
        }
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `;
      // Remove existing style if present
      const existing = document.getElementById('checkbox-keyboard-prevention');
      if (existing) existing.remove();
      document.head.appendChild(style);
      
    },
    onUpdate: ({ editor }) => {
      if (!isInitializing && editorReadyRef.current && !applyingRemoteChangesRef.current) {
        console.log('👤 User interaction detected (not remote update)');
        userInteractedRef.current = true;
        
        // Note: Removed scroll position preservation code as it was causing issues on mobile
        
        // Mark note as having pending changes
        if (note?.id) {
          syncService.markNotePending(note.id);
        }
        
        // NEW: Use pause-based diff system instead of immediate updates
        if (isWebSocketActive && currentNoteId.current) {
          devLog('⌨️ [TYPING] Content changed, starting pause timer');
          handleTypingEvent();
        }
        
        // Removed scroll restoration code
        
      } else if (applyingRemoteChangesRef.current) {
        console.log('🔄 Ignoring programmatic content update (remote changes)');
      }
    },
    editorProps: {
      attributes: {
        style: `
          padding: ${isMobile ? '12px' : '16px'}; 
          font-size: 16px; 
          line-height: 1.2; 
          font-family: "Roboto", "Helvetica", "Arial", sans-serif; 
          min-height: ${isMobile ? '200px' : '300px'}; 
          outline: none;
          overflow-wrap: break-word;
          word-wrap: break-word;
        `,
        class: 'tiptap-editor-content',
      },
    },
  });

  // Prevent mobile keyboard popup when clicking checkboxes while preserving scroll position
  useEffect(() => {
    if (!editor) return;

    const handleCheckboxClick = (event) => {
      if (event.target.type === 'checkbox') {
        // Mark as user interaction for scroll position preservation
        if (!isInitializing && editorReadyRef.current && !applyingRemoteChangesRef.current) {
          userInteractedRef.current = true;
          recentCheckboxInteractionRef.current = Date.now();
          console.log('👤 User interaction confirmed via checkbox - cursor should already be positioned from scroll tracking');
        }
        
        // NUCLEAR OPTION: Temporarily disable editor focus entirely
        const editorDom = editor?.view?.dom;
        if (editorDom) {
          // Store original tabIndex
          const originalTabIndex = editorDom.tabIndex;
          // Make completely unfocusable
          editorDom.tabIndex = -1;
          editorDom.contentEditable = 'false';
          
          // Blur everything
          event.target.blur();
          if (document.activeElement) {
            document.activeElement.blur();
          }
          editorDom.blur();
          document.body.focus();
          
          // Restore focusability after brief delay
          setTimeout(() => {
            editorDom.tabIndex = originalTabIndex;
            editorDom.contentEditable = 'true';
            console.log('✅ Restored editor focusability');
          }, 100);
          
          console.log('✅ Temporarily disabled editor focus for checkbox click');
        }
      }
    };

    const handleTaskItemClick = (event) => {
      const taskItem = event.target.closest('[data-type="taskItem"]');
      if (taskItem && !isInitializing && editorReadyRef.current && !applyingRemoteChangesRef.current) {
        userInteractedRef.current = true;
        recentCheckboxInteractionRef.current = Date.now();
        console.log('👤 User interaction confirmed via task item click');
      }
    };

    // General editor interaction detection
    const handleEditorInteraction = (event) => {
      // Mark any click in the editor as user interaction
      if (!isInitializing && editorReadyRef.current && !applyingRemoteChangesRef.current) {
        const wasAlreadyInteracted = userInteractedRef.current;
        userInteractedRef.current = true;
        if (!wasAlreadyInteracted) {
          console.log('👤 User interaction confirmed via editor click - enabling change detection');
        }
      }
    };

    const editorElement = editor.view.dom;
    editorElement.addEventListener('click', handleCheckboxClick);
    editorElement.addEventListener('click', handleTaskItemClick);
    editorElement.addEventListener('pointerdown', handleEditorInteraction);

    return () => {
      editorElement.removeEventListener('click', handleCheckboxClick);
      editorElement.removeEventListener('click', handleTaskItemClick);
      editorElement.removeEventListener('pointerdown', handleEditorInteraction);
    };
  }, [editor, isInitializing]);

  // Track scroll position AND position cursor in visible area
  useEffect(() => {
    if (!editor) return;

    const handleScroll = () => {
      const editorElement = editor.view.dom;
      const scrollContainer = editorElement?.closest('.MuiBox-root') || editorElement?.parentElement;
      
      if (scrollContainer) {
        const currentScrollTop = scrollContainer.scrollTop;
        lastKnownScrollPositionRef.current = currentScrollTop;
        
        // If user scrolls manually, mark as interaction so scroll position gets preserved
        if (!isInitializing && editorReadyRef.current && !applyingRemoteChangesRef.current) {
          if (!userInteractedRef.current) {
            userInteractedRef.current = true;
            console.log('👤 User interaction detected via scroll - enabling scroll preservation');
          }
          
          // SOLUTION: Position cursor within visible area as user scrolls
          try {
            const containerHeight = scrollContainer.clientHeight;
            const visibleTop = currentScrollTop;
            const visibleBottom = currentScrollTop + containerHeight;
            const visibleMiddle = currentScrollTop + (containerHeight / 2);
            
            // Find cursor position at TOP of visible area for better scroll preservation
            const topOfVisible = visibleTop + 50; // 50px from top of visible area
            const coords = { left: 50, top: topOfVisible }; // 50px from left, near top of visible area
            const pos = editor.view.posAtCoords(coords);
            
            if (pos && pos.pos !== null && pos.pos !== undefined) {
              // Set cursor position without focus (CSS will make it visible)
              editor.view.dispatch(
                editor.view.state.tr.setSelection(
                  editor.view.state.doc.resolve(pos.pos).textSelection || 
                  editor.view.state.selection.constructor.near(editor.view.state.doc.resolve(pos.pos))
                )
              );
              
              console.log('📍 Positioned cursor at TOP of visible area at pos:', pos.pos, 'for scroll:', currentScrollTop);
            }
          } catch (error) {
            console.log('⚠️ Failed to position cursor during scroll:', error);
          }
        }
      }
    };

    const editorElement = editor.view.dom;
    const scrollContainer = editorElement?.closest('.MuiBox-root') || editorElement?.parentElement;
    
    if (scrollContainer) {
      // Use throttling to avoid too many cursor updates during scroll
      let scrollTimeout;
      const throttledHandleScroll = () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(handleScroll, 100); // Update cursor 100ms after scroll stops
      };
      
      scrollContainer.addEventListener('scroll', throttledHandleScroll, { passive: true });
      
      return () => {
        clearTimeout(scrollTimeout);
        scrollContainer.removeEventListener('scroll', throttledHandleScroll);
      };
    }
  }, [editor, isInitializing]);

  // ===== UTILITY FUNCTIONS =====
  const toggleToolbar = useCallback(() => {
    const newState = !toolbarExpanded;
    setToolbarExpanded(newState);
    localStorage.setItem('noteEditorToolbarExpanded', JSON.stringify(newState));
  }, [toolbarExpanded]);

  const getCurrentContent = useCallback(() => {
    if (!editor) return '';
    return editor.getHTML();
  }, [editor]);

  const handleUserInteraction = useCallback(() => {
    if (!isInitializing && editorReadyRef.current && !applyingRemoteChangesRef.current) {
      const wasInteracted = userInteractedRef.current;
      userInteractedRef.current = true;
      
      console.log('👤 User interaction confirmed - enabling change detection', {
        wasAlreadyInteracted: wasInteracted,
        isInitializing,
        editorReady: editorReadyRef.current,
        applyingRemote: applyingRemoteChangesRef.current
      });
      
      // Mark note as having pending changes
      if (note?.id) {
        syncService.markNotePending(note.id);
      }
    } else {
      console.log('⏸️ User interaction ignored:', {
        isInitializing,
        editorReady: editorReadyRef.current,
        applyingRemote: applyingRemoteChangesRef.current,
        reason: isInitializing ? 'initializing' : !editorReadyRef.current ? 'editor not ready' : 'applying remote changes'
      });
    }
  }, [isInitializing, note?.id]);

  const handleTitleChange = useCallback((e) => {
    const newTitle = e.target.value;
    console.log('📝 Title changing:', {
      from: title,
      to: newTitle,
      isInitializing,
      editorReady: editorReadyRef.current
    });
    
    setTitle(newTitle);
    handleUserInteraction();
    
    // Send real-time title update if WebSocket available
    if (isWebSocketActive && currentNoteId.current && !applyingRemoteChangesRef.current) {
      sendRealtimeUpdate({ title: newTitle });
    }
  }, [handleUserInteraction, title, isInitializing, sendRealtimeUpdate]);

  const handleTitleFocus = useCallback((e) => {
    console.log('📝 Title field focused:', {
      currentTitle: title,
      shouldClear: title === 'Untitled'
    });
    
    if (title === 'Untitled') {
      setTitle('');
      handleUserInteraction();
    }
  }, [title, handleUserInteraction]);

  const checkForChanges = useCallback(() => {
    if (!note || !editorReadyRef.current || isInitializing || !userInteractedRef.current || !editor) {
      return false;
    }

    if (applyingRemoteChangesRef.current) {
      console.log('🔄 Skipping change detection - applying remote changes');
      return false;
    }

    const currentTitle = title || '';
    const initialTitle = initialValues.current.title || '';
    const titleChanged = currentTitle !== initialTitle;
    
    const currentContent = getCurrentContent();
    const initialContent = initialValues.current.content || '';
    const contentChanged = currentContent !== initialContent;
    
    // Enhanced false conflict detection
    const isLikelyTitleTimingIssue = !currentTitle && initialTitle && 
                                   (initialTitle === 'offline test' || initialTitle.length > 0);
    const isEmptyTitleButShouldBe = !currentTitle && initialTitle;
    
    // Don't count title changes if it's likely a timing issue
    const realTitleChanged = titleChanged && !isLikelyTitleTimingIssue && !isEmptyTitleButShouldBe;
    
    const hasChanges = realTitleChanged || contentChanged;
    
    if (hasChanges) {
      console.log('🔍 Local changes detected:', {
        titleChanged: realTitleChanged,
        contentChanged,
        isLikelyTitleTimingIssue,
        isEmptyTitleButShouldBe,
        currentTitle: currentTitle.substring(0, 30) + (currentTitle.length > 30 ? '...' : ''),
        initialTitle: initialTitle.substring(0, 30) + (initialTitle.length > 30 ? '...' : ''),
        currentContentLength: currentContent?.length || 0,
        initialContentLength: initialContent?.length || 0,
        contentPreview: currentContent?.substring(0, 100) + '...',
        initialContentPreview: initialContent?.substring(0, 100) + '...',
        userInteracted: userInteractedRef.current,
        editorReady: editorReadyRef.current,
        applyingRemote: applyingRemoteChangesRef.current
      });
    } else {
      // Only log occasionally to avoid spam
      if (Math.random() < 0.01) { // 1% chance
        console.log('✅ No local changes detected:', {
          titlesSame: currentTitle === initialTitle,
          contentsSame: currentContent === initialContent,
          userInteracted: userInteractedRef.current,
          isLikelyTitleTimingIssue,
          currentTitle: `"${currentTitle}"`,
          initialTitle: `"${initialTitle}"`
        });
      }
    }
    
    return hasChanges;
  }, [note, title, isInitializing, getCurrentContent, editor]);

  // Enhanced applyRemoteChanges with conflict resolution
  const applyRemoteChanges = useCallback(({ content, title: remoteTitle, updatedAt, strategy = 'replace' }) => {
    console.log('🔄 Applying remote changes with strategy:', strategy, {
      hasContent: !!content,
      hasTitle: !!remoteTitle,
      updatedAt,
      currentTitle: title,
      currentContent: getCurrentContent()?.substring(0, 100) + '...'
    });
    
    applyingRemoteChangesRef.current = true;
    
    try {
      let finalContent = content;
      let finalTitle = remoteTitle || title;
      
      // Apply conflict resolution strategy if needed
      if (strategy === 'merge' && content && getCurrentContent()) {
        const currentContent = getCurrentContent();
        finalContent = ConflictResolutionStrategies.intelligentMerge(
          currentContent, 
          content, 
          { remoteTimestamp: updatedAt }
        );
        console.log('🔀 Applied intelligent merge strategy');
      }
      
      // Update initial values FIRST with the new values we're about to apply
      const newInitialValues = { 
        title: finalTitle, 
        content: finalContent || getCurrentContent() 
      };
      initialValues.current = newInitialValues;
      console.log('📝 Updated initial values before applying changes:', {
        title: newInitialValues.title,
        contentLength: newInitialValues.content?.length || 0
      });
      
      // IMPORTANT: Reset user interaction flag BEFORE updating content
      userInteractedRef.current = false;
      console.log('🔄 Reset user interaction flag - content now in sync');
      
      if (finalContent && finalContent !== getCurrentContent()) {
        console.log('📝 Updating editor content');
        
        // PRESERVE SCROLL POSITION during content updates - use tracked position
        const editorElement = editor?.view?.dom;
        const scrollContainer = editorElement?.closest('.MuiBox-root') || editorElement?.parentElement;
        const scrollTop = lastKnownScrollPositionRef.current || scrollContainer?.scrollTop || 0;
        
        console.log('📍 Preserving scroll position:', scrollTop, '(tracked:', lastKnownScrollPositionRef.current, ', current:', scrollContainer?.scrollTop, ')');
        
        editor?.commands.setContent(finalContent);
        
        // Restore scroll position after content update
        setTimeout(() => {
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollTop;
            console.log('📍 Restored scroll position:', scrollTop);
          }
        }, 10); // Small delay to ensure content is rendered
      }
      
      if (finalTitle && finalTitle !== title) {
        console.log('📝 Updating title:', finalTitle);
        setTitle(finalTitle);
      }
      
      noteTimestampRef.current = updatedAt;
      setLastUpdateTimestamp(updatedAt);
      setLastSaved(new Date(updatedAt));
      setHasRemoteChanges(true);
      
      // Clear pending status since we've synced
      if (note?.id) {
        syncService.clearNotePending(note.id);
      }
      
      // CRITICAL: Update cache with remote changes to prevent data loss on screen off/on
      if (note?.id && currentUser?.id) {
        const updatedNote = {
          ...note,
          title: finalTitle,
          content: finalContent,
          updatedAt: updatedAt
        };
        offlineStorage.storeNote(updatedNote, currentUser.id, { fromServer: true })
          .catch(error => console.warn('Failed to cache remote update:', error));
      }
      
      setTimeout(() => setHasRemoteChanges(false), 3000);
      
    } finally {
      // Longer delay to ensure React state updates complete
      setTimeout(() => {
        applyingRemoteChangesRef.current = false;
        console.log('🔄 Remote changes application complete');
      }, 200);
    }
    
  }, [editor, getCurrentContent, title, note?.id]);

  // Set up global callback for direct editor updates (bulk sync bypass)
  useEffect(() => {
    const handleDirectUpdate = (updateData) => {
      if (note?.id && updateData) {
        console.log('🎯 [DIRECT UPDATE] Received bulk sync update for current note:', {
          noteId: note.id,
          hasContent: !!updateData.content,
          hasTitle: !!updateData.title,
          updatedAt: updateData.updatedAt
        });
        
        // Use the same applyRemoteChanges path that real-time sync uses
        applyRemoteChanges({
          content: updateData.content,
          title: updateData.title,
          updatedAt: updateData.updatedAt,
          strategy: 'replace'
        });
      }
    };
    
    // Expose the callback globally for App.js to call
    window.noteEditorDirectUpdate = handleDirectUpdate;
    
    return () => {
      // Clean up on unmount
      if (window.noteEditorDirectUpdate === handleDirectUpdate) {
        delete window.noteEditorDirectUpdate;
      }
    };
  }, [note?.id, applyRemoteChanges]);

  const saveNote = useCallback(async (noteId, updates) => {
    if (!noteId) return;
    
    setSaving(true);
    lastLocalUpdateRef.current = Date.now();
    
    try {
      const response = await onUpdateNote(noteId, updates);
      const savedNote = response?.data || response;
      
      setLastSaved(new Date());
      setHasUnsavedChanges(false);
      
      if (savedNote?.updatedAt) {
        const newTimestamp = savedNote.updatedAt;
        console.log('💾 Save successful, updating timestamps:', {
          oldTimestamp: noteTimestampRef.current,
          newTimestamp,
          noteId
        });
        
        noteTimestampRef.current = newTimestamp;
        setLastUpdateTimestamp(newTimestamp);
      }
      
      initialValues.current = { 
        title: updates.title !== undefined ? updates.title : title,
        content: updates.content !== undefined ? updates.content : getCurrentContent()
      };
      
      // Clear pending status after successful save
      syncService.clearNotePending(noteId);
      
      console.log('💾 Save successful, updated initial values');
      
      // Update initial values after save to prevent false conflict detection
      setTimeout(() => {
        initialValues.current = { 
          title: updates.title !== undefined ? updates.title : title,
          content: updates.content !== undefined ? updates.content : getCurrentContent()
        };
        console.log('📝 Updated initial values after save delay');
      }, 100);
      
    } catch (error) {
      console.error('Auto-save failed:', error);
      if (error.response?.status === 423) {
        setLockError('Note is locked by another user');
      } else if (error.response?.status === 403) {
        setLockError('You do not have permission to edit this note');
      }
    } finally {
      setSaving(false);
    }
  }, [onUpdateNote, title, getCurrentContent]);

  // Legacy HTTP-based functions (fallback when WebSocket unavailable)
  const checkForUpdates = useCallback(async () => {
    const effectiveTimestamp = lastUpdateTimestamp || noteTimestampRef.current;
    
    if (!note?.id || !effectiveTimestamp || syncingChanges || applyingRemoteChangesRef.current) {
      return;
    }
    
    try {
      setSyncingChanges(true);
      const response = await api.get(`/api/notes/${note.id}/updates?since=${effectiveTimestamp}`);
      const { content, title: remoteTitle, updatedAt, lastEditor } = response.data;
      
      const timeSinceLocalUpdate = lastLocalUpdateRef.current ? Date.now() - lastLocalUpdateRef.current : Infinity;
      if (lastEditor?.id === currentUser?.id && timeSinceLocalUpdate < 5000) {
        console.log('⭐ Skipping own update (within 5 seconds)');
        noteTimestampRef.current = updatedAt;
        setLastUpdateTimestamp(updatedAt);
        return;
      }
      
      if (!updatedAt) {
        return;
      }
      
      const newTimestamp = new Date(updatedAt).getTime();
      const currentTimestamp = new Date(effectiveTimestamp).getTime();
      
      if (newTimestamp <= currentTimestamp) {
        return;
      }
      
      console.log('🔄 Remote changes detected:', { 
        updatedAt, 
        lastEditor: lastEditor?.name,
        timeSinceLocal: timeSinceLocalUpdate + 'ms'
      });
      
      const hasLocalChanges = checkForChanges();
      
      if (hasLocalChanges && !applyingRemoteChangesRef.current && !bulkSyncInProgress) {
        console.log('⚠️ Conflict detected - showing resolution dialog');
        setPendingRemoteUpdate({ content, title: remoteTitle, updatedAt, lastEditor });
        setConflictDialogOpen(true);
      } else if (bulkSyncInProgress) {
        console.log('🔄 [BULK SYNC] Suppressing conflict dialog during bulk sync operation');
        applyRemoteChanges({ content, title: remoteTitle, updatedAt });
      } else {
        console.log('✅ Applying remote changes directly (no conflict)');
        applyRemoteChanges({ content, title: remoteTitle, updatedAt });
      }
      
    } catch (error) {
      if (error.response?.status === 429) {
        console.log('⏸️ Rate limited - will retry later');
        return;
      }
      console.error('❌ Failed to check for updates:', error);
    } finally {
      setSyncingChanges(false);
    }
  }, [note?.id, lastUpdateTimestamp, currentUser?.id, checkForChanges, syncingChanges, applyRemoteChanges]);

  const checkActiveEditors = useCallback(async () => {
    if (!note?.id) {
      return;
    }
    
    try {
      const response = await api.get(`/api/notes/${note.id}/presence`);
      const editors = response.data.activeEditors || [];
      
      console.log('🔍 HTTP presence check - filtering editors:', {
        editors,
        currentUserId: currentUser?.id,
        currentUserEmail: currentUser?.email
      });
      
      // Filter out current user (HTTP endpoint might use different field names)
      const otherEditors = editors.filter(editor => {
        return editor.id !== currentUser?.id && 
               editor.userId !== currentUser?.id &&
               editor.email !== currentUser?.email;
      });
      
      console.log('👥 HTTP active editors (filtered):', otherEditors);
      setActiveEditors(otherEditors);
      
    } catch (error) {
      if (error.response?.status === 500) {
        console.log('⚠️ Presence endpoint not available (500) - continuing without presence detection');
      } else if (error.response?.status !== 429) {
        console.error('❌ Failed to check active editors:', error);
      }
    }
  }, [note?.id, currentUser?.id]);

  // Manual bulk sync trigger
  const handleManualBulkSync = useCallback(async () => {
    if (bulkSyncInProgress || !currentUser || !notes || notes.length === 0) {
      return;
    }
    
    setLocalBulkSyncInProgress(true);
    console.log('🔄 Manual bulk sync triggered');
    
    try {
      // Use WebSocket for bulk sync if available
      if (isWebSocketActive) {
        const noteTimestamps = {};
        notes.forEach(note => {
          if (note.updatedAt) {
            noteTimestamps[note.id] = note.updatedAt;
          }
        });
        
        webSocketManager.requestBulkSync(noteTimestamps);
        
        // Wait a bit then also run HTTP-based sync as backup
        setTimeout(async () => {
          const results = await syncService.syncAllNotes(notes, currentUser);
          handleBulkSyncResults(results);
        }, 1000);
        
      } else {
        // HTTP-only bulk sync
        const results = await syncService.syncAllNotes(notes, currentUser);
        handleBulkSyncResults(results);
      }
      
    } catch (error) {
      console.error('❌ Manual bulk sync failed:', error);
    } finally {
      setLocalBulkSyncInProgress(false);
      // Also set the timestamp for manual bulk sync completion
      recentBulkSyncRef.current = Date.now();
      console.log('🕒 Manual bulk sync completed, setting recentBulkSyncRef timestamp:', recentBulkSyncRef.current);
    }
  }, [bulkSyncInProgress, currentUser, notes, handleBulkSyncResults]);

  // ===== OTHER FUNCTIONS (keeping existing implementations) =====
  const handleManualSave = useCallback(async () => {
    if (!note || !editor) return;
    
    const updates = {};
    
    const currentTitle = title || '';
    const initialTitle = initialValues.current.title || '';
    if (currentTitle !== initialTitle) {
      updates.title = title;
    }
    
    const currentContent = getCurrentContent();
    const initialContent = initialValues.current.content || '';
    
    // Use shared normalization function to prevent ghost saves from whitespace/encoding differences
    
    const normalizedCurrent = normalizeContent(currentContent);
    const normalizedInitial = normalizeContent(initialContent);
    
    if (normalizedCurrent !== normalizedInitial) {
      updates.content = currentContent; // Save the original, not normalized version
      console.log('📝 Content change detected after normalization:', {
        currentLength: currentContent.length,
        initialLength: initialContent.length,
        normalizedCurrentLength: normalizedCurrent.length,
        normalizedInitialLength: normalizedInitial.length,
        actualChange: normalizedCurrent !== normalizedInitial
      });
    }
    
    if (Object.keys(updates).length > 0) {
      console.log('Manual save triggered with changes:', updates);
      await saveNote(note.id, updates);
    }
  }, [note, title, getCurrentContent, saveNote, editor]);

  // Enhanced conflict resolution with strategies
  const handleConflictResolution = useCallback(async (resolution) => {
    console.log('🔧 Resolving conflict with strategy:', resolution);
    
    if (!pendingRemoteUpdate) return;
    
    const { content: remoteContent, title: remoteTitle, updatedAt } = pendingRemoteUpdate;
    
    if (resolution === 'accept') {
      console.log('✅ Accepting remote changes');
      applyRemoteChanges(pendingRemoteUpdate);
      setHasUnsavedChanges(false);
      
    } else if (resolution === 'reject') {
      console.log('❌ Rejecting remote changes');
      setLastUpdateTimestamp(updatedAt);
      
    } else if (resolution === 'merge') {
      console.log('🔀 Merging changes');
      const currentContent = getCurrentContent();
      const currentTitle = title;
      
      // Use intelligent merge strategy
      const finalContent = ConflictResolutionStrategies.intelligentMerge(
        currentContent,
        remoteContent,
        { remoteTimestamp: updatedAt }
      );
      
      const hasLocalTitleChanges = currentTitle !== initialValues.current.title;
      const finalTitle = hasLocalTitleChanges ? currentTitle : remoteTitle;
      
      setTitle(finalTitle);
      
      // PRESERVE SCROLL POSITION during conflict resolution
      const editorElement = editor?.view?.dom;
      const scrollContainer = editorElement?.closest('.MuiBox-root') || editorElement?.parentElement;
      const scrollTop = scrollContainer?.scrollTop || 0;
      
      editor?.commands.setContent(finalContent);
      
      // Restore scroll position
      setTimeout(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollTop;
        }
      }, 10);
      
      setLastUpdateTimestamp(updatedAt);
      
      setTimeout(() => {
        saveNote(note.id, { title: finalTitle, content: finalContent });
      }, 500);
      
    } else if (resolution === 'smart-merge') {
      console.log('🧠 Smart merging changes');
      // Use smart merge for lists
      const currentContent = getCurrentContent();
      const finalContent = ConflictResolutionStrategies.smartMergeList(currentContent, remoteContent);
      
      // PRESERVE SCROLL POSITION during conflict resolution
      const editorElement = editor?.view?.dom;
      const scrollContainer = editorElement?.closest('.MuiBox-root') || editorElement?.parentElement;
      const scrollTop = scrollContainer?.scrollTop || 0;
      
      editor?.commands.setContent(finalContent);
      
      // Restore scroll position
      setTimeout(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollTop;
        }
      }, 10);
      
      setLastUpdateTimestamp(updatedAt);
      
      setTimeout(() => {
        saveNote(note.id, { content: finalContent });
      }, 500);
    }
    
    setConflictDialogOpen(false);
    setPendingRemoteUpdate(null);
    
  }, [pendingRemoteUpdate, applyRemoteChanges, getCurrentContent, title, editor, saveNote, note?.id]);

  // ===== IMAGE UPLOAD FUNCTIONS (keeping existing implementations) =====
  const storeImageOffline = useCallback(async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const tempId = `temp_img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const imageData = {
          id: tempId,
          url: reader.result,
          offline: true,
          file: {
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified
          },
          fileData: reader.result,
          noteId: note?.id,
          createdAt: new Date().toISOString()
        };

        try {
          const offlineImages = JSON.parse(localStorage.getItem('offlineImages') || '[]');
          offlineImages.push(imageData);
          localStorage.setItem('offlineImages', JSON.stringify(offlineImages));
          
          resolve({
            url: reader.result,
            width: null,
            height: null,
            offline: true,
            id: tempId
          });
        } catch (storageError) {
          reject(new Error('Failed to store image offline. Storage may be full.'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read image file'));
      reader.readAsDataURL(file);
    });
  }, [note?.id]);

  const uploadImage = useCallback(async (file) => {
    if (!note?.id) {
      throw new Error('No note selected');
    }

    if (file.size > 10 * 1024 * 1024) {
      throw new Error('Image must be smaller than 10MB');
    }

    if (!file.type.startsWith('image/')) {
      throw new Error('File must be an image');
    }

    if (!navigator.onLine) {
      return await storeImageOffline(file);
    }

    const formData = new FormData();
    formData.append('image', file);

    try {
      const response = await api.api.post(`/api/notes/${note.id}/images`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(percentCompleted);
        }
      });

      return {
        url: `${api.baseURL}${response.data.url}`,
        width: response.data.width,
        height: response.data.height,
        size: response.data.size,
        id: response.data.id,
        offline: false
      };
    } catch (error) {
      console.error('Upload error:', error);
      if (error.response?.status === 413) {
        throw new Error('Image too large. Maximum size is 10MB.');
      } else if (error.response?.status === 400) {
        throw new Error('Invalid image file.');
      } else if (error.response?.status === 403) {
        throw new Error('No permission to upload images to this note.');
      } else if (error.code === 'NETWORK_ERROR' || !navigator.onLine) {
        return await storeImageOffline(file);
      } else {
        throw new Error('Failed to upload image. Please try again.');
      }
    }
  }, [note?.id, storeImageOffline]);

  const handleImageUpload = useCallback(async (file) => {
    if (!file) return;

    setImageUploading(true);
    setImageError('');
    setUploadProgress(0);

    try {
      const result = await uploadImage(file);
      
      editor?.chain().focus().setImage({
        src: result.url,
        alt: file.name,
        title: file.name,
        'data-image-id': result.id
      }).run();

      setImageUploadDialog(false);
      
      if (result.offline) {
        setImageError('');
      }
      
    } catch (error) {
      setImageError(error.message);
    } finally {
      setImageUploading(false);
      setUploadProgress(0);
    }
  }, [uploadImage, editor]);

  const handleMultipleFiles = useCallback(async (files) => {
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    
    if (imageFiles.length === 0) {
      setImageError('No image files found');
      return;
    }

    if (imageFiles.length > 5) {
      setImageError('Maximum 5 images at once');
      return;
    }

    for (const file of imageFiles) {
      await handleImageUpload(file);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }, [handleImageUpload]);

  // ===== DRAG AND DROP HANDLERS (keeping existing implementations) =====
  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    
    if (e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    
    if (dragCounterRef.current === 0) {
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    
    setDragOver(false);
    dragCounterRef.current = 0;
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleMultipleFiles(files);
    }
  }, [handleMultipleFiles]);

  const handleFileInputChange = useCallback((event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      handleMultipleFiles(files);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [handleMultipleFiles]);

  // ===== NAVIGATION HANDLERS =====
  const handleBack = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    
    await handleManualSave();
    
    // Clear pending status when leaving note
    if (note?.id) {
      syncService.clearNotePending(note.id);
    }
    
    // Leave WebSocket room
    if (isWebSocketActive && currentNoteId.current) {
      await webSocketManager.leaveNote(currentNoteId.current);
    }
    
    if (onBack) {
      onBack();
    }
  }, [handleManualSave, note?.id, onBack]);

  // ===== TOOLBAR HANDLERS (keeping existing implementations) =====
  const handleBold = () => editor?.chain().focus().toggleBold().run();
  const handleItalic = () => editor?.chain().focus().toggleItalic().run();
  const handleUnderline = () => editor?.chain().focus().toggleUnderline().run();
  const handleStrikethrough = () => editor?.chain().focus().toggleStrike().run();
  const handleBulletList = () => editor?.chain().focus().toggleBulletList().run();
  const handleOrderedList = () => editor?.chain().focus().toggleOrderedList().run();
  const handleTaskList = () => editor?.chain().focus().toggleTaskList().run();
  const handleBlockquote = () => editor?.chain().focus().toggleBlockquote().run();
  const handleCodeBlock = () => editor?.chain().focus().toggleCodeBlock().run();
  const handleUndo = () => editor?.chain().focus().undo().run();
  const handleRedo = () => editor?.chain().focus().redo().run();

  const handleLink = () => {
    const url = window.prompt('Enter URL:');
    if (url) {
      editor?.chain().focus().setLink({ href: url }).run();
    }
  };

  const handleImageButton = () => {
    setImageUploadDialog(true);
    setImageError('');
  };

  // ===== LOCK MANAGEMENT (keeping existing implementations) =====
  const releaseLock = useCallback(async (noteId) => {
    if (!noteId) return;
    
    try {
      await fetch(`${api.baseURL}/api/notes/${noteId}/lock`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      });
    } catch (error) {
      console.error('Failed to release lock:', error);
    } finally {
      setIsLocked(false);
      setLockError('');
      if (lockExtensionIntervalRef.current) {
        clearInterval(lockExtensionIntervalRef.current);
        lockExtensionIntervalRef.current = null;
      }
    }
  }, []);

  const startLockExtension = useCallback((noteId) => {
    if (lockExtensionIntervalRef.current) {
      clearInterval(lockExtensionIntervalRef.current);
    }
    
    lockExtensionIntervalRef.current = setInterval(async () => {
      try {
        const extendResponse = await fetch(`${api.baseURL}/api/notes/${noteId}/lock`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
          },
          credentials: 'include'
        });
        
        if (!extendResponse.ok) {
          const errorData = await extendResponse.json().catch(() => ({}));
          const errorMsg = errorData.error || 'Failed to extend lock';
          
          console.warn(`Lock extension failed (${extendResponse.status}):`, errorMsg);
          
          if (extendResponse.status === 409 || extendResponse.status === 423) {
            console.error('Lock conflict during extension');
            setLockError('Another user is now editing this note');
            setIsLocked(false);
            clearInterval(lockExtensionIntervalRef.current);
            lockExtensionIntervalRef.current = null;
          } else if (extendResponse.status === 400) {
            console.warn('Lock no longer exists - stopping extension attempts');
            setIsLocked(false);
            clearInterval(lockExtensionIntervalRef.current);
            lockExtensionIntervalRef.current = null;
          }
        } else {
          console.log('✅ Lock extended successfully');
        }
      } catch (error) {
        if (error.message.includes('ERR_INTERNET_DISCONNECTED') || error.message.includes('NetworkError')) {
          console.warn('Network disconnected, will retry lock extension');
        } else {
          console.warn('Lock extension failed:', error.message);
        }
      }
    }, 15000);
  }, []);

  const acquireLock = useCallback(async (noteId) => {
    if (!noteId) return false;
    
    // Clear any existing lock extension to prevent conflicts
    if (lockExtensionIntervalRef.current) {
      clearInterval(lockExtensionIntervalRef.current);
      lockExtensionIntervalRef.current = null;
    }
    
    try {
      const response = await fetch(`${api.baseURL}/api/notes/${noteId}/lock`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || 'Failed to acquire lock';
        
        if (response.status === 409 || response.status === 423) {
          setLockError(errorMsg);
          console.log('🔄 Note is locked by another user, starting lock polling');
          startLockPolling(noteId);
        }
        setIsLocked(false);
        return false;
      }
      
      setIsLocked(true);
      setLockError('');
      startLockExtension(noteId);
      
      return true;
    } catch (error) {
      if (error.message.includes('ERR_INTERNET_DISCONNECTED') || error.message.includes('NetworkError')) {
        console.warn('Network disconnected during lock acquisition');
        setLockError('Network connection lost - changes may not save');
      } else {
        console.error('Lock acquisition failed:', error);
      }
      setIsLocked(false);
      return false;
    }
  }, [startLockExtension]);

  // Lock polling functions for automatic unlock detection and retry
  const startLockPolling = useCallback((noteId) => {
    if (!noteId) return;
    
    // Clear any existing polling
    stopLockPolling();
    
    console.log('🔄 Starting lock polling for note:', noteId);
    
    const pollLockStatus = async () => {
      try {
        const response = await api.get(`/api/notes/${noteId}`);
        const noteData = response.data;
        
        if (!noteData.locked) {
          console.log('✅ Lock has been released, attempting to acquire lock');
          setLockError('');
          setLockOwner(null);
          setIsLocked(false);
          stopLockPolling();
          
          // Try to acquire the lock now that it's available
          try {
            const lockResponse = await fetch(`${api.baseURL}/api/notes/${noteId}/lock`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
                'Content-Type': 'application/json'
              },
              credentials: 'include'
            });

            if (lockResponse.ok) {
              console.log('✅ Successfully acquired lock after polling');
              setIsLocked(true);
              setLockError('');
              
              // Start lock extension using shared function
              startLockExtension(noteId);
              
            } else {
              console.log('⚠️ Failed to acquire lock after polling, will try again');
              // Start polling again in case another user got it first
              setTimeout(() => startLockPolling(noteId), 1000);
            }
          } catch (error) {
            console.error('Error acquiring lock after polling:', error);
            setTimeout(() => startLockPolling(noteId), 2000);
          }
        } else {
          console.log('🔒 Note still locked, continuing to poll');
        }
      } catch (error) {
        console.error('Lock polling failed:', error);
        // Continue polling on error - might be temporary network issue
      }
    };
    
    // Poll every 3 seconds (more aggressive)
    lockPollingIntervalRef.current = setInterval(pollLockStatus, 3000);
    
    // Also poll immediately
    pollLockStatus();
  }, []);

  const stopLockPolling = useCallback(() => {
    if (lockPollingIntervalRef.current) {
      console.log('🛑 Stopping lock polling');
      clearInterval(lockPollingIntervalRef.current);
      lockPollingIntervalRef.current = null;
    }
  }, []);

  // WATCHDOG: Efficient refresh current note function using bulk sync logic
  const refreshCurrentNote = useCallback(async () => {
    if (!currentNoteId.current) {
      console.log('⚠️ WATCHDOG: No current note to refresh');
      return;
    }

    try {
      console.log('🔄 WATCHDOG: Starting efficient sync for current note:', currentNoteId.current);
      
      // Step 1: Get server metadata for hash comparison (same as bulk sync)
      const metadataResponse = await api.get('/api/notes/sync-metadata');
      const serverMetadata = metadataResponse.data;
      const noteServerData = serverMetadata[currentNoteId.current];
      
      if (!noteServerData) {
        console.log('⚠️ WATCHDOG: Note not found in server metadata');
        return;
      }
      
      // Step 2: Calculate local hash (same logic as bulk sync)
      const localContent = note?.content || '';
      const localTitle = note?.title || '';
      const localHash = await offlineStorage.calculateHash(localContent, localTitle);
      
      console.log('🔍 WATCHDOG: Comparing hashes:', {
        localHash: localHash.substring(0, 8),
        serverHash: noteServerData.hash?.substring(0, 8),
        hashesMatch: localHash === noteServerData.hash,
        serverUpdatedAt: noteServerData.updatedAt,
        localUpdatedAt: note?.updatedAt
      });
      
      // Step 3: Only fetch if hash differs (efficient!)
      if (localHash === noteServerData.hash) {
        console.log('✅ WATCHDOG: Note unchanged (hash match) - no fetch needed');
        return;
      }
      
      console.log('🔄 WATCHDOG: Hash differs, fetching updated note content');
      const response = await api.get(`/api/notes/${currentNoteId.current}`);
      
      if (response.data) {
        const updatedNote = response.data;
        console.log('📥 WATCHDOG: Received updated note via efficient sync:', {
          noteId: updatedNote.id,
          title: updatedNote.title,
          contentLength: updatedNote.content?.length,
          updatedAt: updatedNote.updatedAt,
          currentNoteUpdatedAt: note?.updatedAt
        });
        
        // Apply the updated content directly using the same mechanism as real-time updates
        applyRemoteChanges({
          content: updatedNote.content,
          title: updatedNote.title,
          timestamp: updatedNote.updatedAt,
          editor: { name: 'Efficient Sync' }
        });
        
        console.log('✅ WATCHDOG: Applied updated note content via efficient sync');
      }
      
    } catch (error) {
      console.error('❌ WATCHDOG: Efficient sync failed, falling back to full fetch:', error);
      
      // Fallback to simple full fetch if efficient sync fails
      try {
        console.log('🔄 WATCHDOG: Using fallback full fetch');
        const response = await api.get(`/api/notes/${currentNoteId.current}`);
        if (response.data) {
          const updatedNote = response.data;
          if (note && updatedNote.updatedAt !== note.updatedAt) {
            applyRemoteChanges({
              content: updatedNote.content,
              title: updatedNote.title,
              timestamp: updatedNote.updatedAt,
              editor: { name: 'Fallback Sync' }
            });
            console.log('✅ WATCHDOG: Applied note content via fallback');
          }
        }
      } catch (fallbackError) {
        console.error('❌ WATCHDOG: Both efficient and fallback sync failed:', fallbackError);
      }
    }
  }, [note, applyRemoteChanges]);

  // ===== EFFECTS =====

  // WATCHDOG: Track connection state changes to refresh note after offline→online
  const connectionStateRef = useRef('disconnected');
  const wasOfflineRef = useRef(false);
  
  // Initialize WebSocket when connection becomes available
  useEffect(() => {
    if (isWebSocketActive) {
      console.log('🔌 WebSocket became active, setting up listeners');
      setupWebSocketListeners();
      setConnectionStatus('connected');
      
      // WATCHDOG: Detect offline→online transition
      const wasDisconnected = connectionStateRef.current !== 'connected';
      connectionStateRef.current = 'connected';
      
      if (wasDisconnected && currentNoteId.current) {
        console.log('🔄 WATCHDOG: Detected offline→online transition, refreshing current note');
        wasOfflineRef.current = true;
        // Defer note refresh to avoid race conditions with bulk sync
        setTimeout(() => {
          if (currentNoteId.current && wasOfflineRef.current) {
            refreshCurrentNote();
            wasOfflineRef.current = false;
          }
        }, 1000); // 1 second delay to let bulk sync complete first
      }
      
      // Stop any HTTP polling
      stopLegacyPolling();
      
      // CRITICAL: Rejoin note and sync after reconnection
      setTimeout(async () => {
        try {
          console.log('🔄 WebSocket reconnected, rejoining note and syncing...');
          
          // Rejoin note collaboration if we have a current note
          console.log('🔍 Rejoin debug:', {
            hasCurrentNoteId: !!currentNoteId.current,
            currentNoteId: currentNoteId.current,
            hasNote: !!note,
            noteShared: note?.shared,
            noteHasBeenShared: note?.hasBeenShared
          });
          
          if (currentNoteId.current) {
            console.log('🤝 Rejoining note collaboration after reconnection');
            await webSocketManager.joinNote(currentNoteId.current);
            setRealtimeEnabled(true);
          } else {
            console.log('⚠️ No current note ID to rejoin');
          }
          
          // Trigger FULL note sync to get latest data after reconnection
          if (currentNoteId.current) {
            try {
              console.log('🔄 Doing FULL note sync after reconnection:', currentNoteId.current);
              const response = await api.get(`/api/notes/${currentNoteId.current}`);
              if (response.data) {
                const updatedNote = response.data;
                console.log('📥 Received full note update after reconnection:', {
                  noteId: updatedNote.id,
                  title: updatedNote.title,
                  contentLength: updatedNote.content?.length,
                  updatedAt: updatedNote.updatedAt,
                  contentHash: updatedNote.contentHash
                });
                
                // CRITICAL: Apply conflict resolution logic during reconnection
                if (currentUser) {
                  const shouldDefer = await offlineStorage.shouldDeferToServer(updatedNote.id, updatedNote);
                  if (shouldDefer) {
                    console.log('✅ Deferring to server version after reconnection');
                    await offlineStorage.storeNote(updatedNote, currentUser.id, { fromServer: true });
                  } else {
                    console.log('⚠️ Local changes detected - preserving local version but updating original hash');
                    // Don't overwrite local changes, but update the original hash to reflect
                    // what the server state was when we reconnected
                    const cachedNote = await offlineStorage.getCachedNote(updatedNote.id);
                    if (cachedNote && updatedNote.contentHash) {
                      await offlineStorage.updateOriginalHashAfterSync(
                        updatedNote.id, 
                        updatedNote.contentHash, 
                        updatedNote.content, 
                        updatedNote.title
                      );
                    }
                    // Don't update the React state in this case - preserve local changes
                    return;
                  }
                }
                
                // Update the note in App.js state directly without triggering a save
                // This is just syncing the client state with server data, not saving changes
                if (onNotesUpdated) {
                  // Use onNotesUpdated to update the local state without triggering a save
                  const updatedNotes = notes.map(n => 
                    n.id === updatedNote.id ? { ...n, ...updatedNote } : n
                  );
                  onNotesUpdated(updatedNotes);
                }
                
                // Force the editor to refresh with the latest content if timestamps differ
                if (note && updatedNote.updatedAt !== note.updatedAt) {
                  console.log('🔄 Timestamps differ, forcing editor update');
                  // The parent update should trigger a re-render with fresh note data
                }
              }
            } catch (syncError) {
              console.error('❌ Full note sync failed after reconnection:', syncError);
            }
          }
        } catch (error) {
          console.error('❌ Failed to sync after WebSocket reconnection:', error);
        }
      }, 1000); // Small delay to ensure connection is fully established
    } else {
      console.log('📡 WebSocket not active, connection mode:', connectionMode);
      setConnectionStatus(connectionMode === 'offline' ? 'disconnected' : 'http-fallback');
      setRealtimeEnabled(false);
      
      // WATCHDOG: Track when we go offline
      connectionStateRef.current = 'disconnected';
    }
  }, [isWebSocketActive, connectionMode, setupWebSocketListeners, stopLegacyPolling]);

  // Setup app lifecycle integration
//  useEffect(() => {
    // This is handled by App.js now, we just need to respond to changes
//    if (websocketConnected !== isWebSocketActive) {
//      setWebsocketConnected(isWebSocketActive);
//    }
//  }, [isWebSocketActive, websocketConnected]);

  // Reset state when note changes
  useEffect(() => {
    if (note && note.id !== currentNoteId.current) {
      console.log('📝 Loading new note:', {
        noteId: note.id,
        title: note.title || 'Untitled',
        shared: note.shared,
        hasBeenShared: note.hasBeenShared
      });
      
      // Cleanup previous note
      if (currentNoteId.current) {
        console.log('🧹 Cleaning up previous note:', currentNoteId.current);
        releaseLock(currentNoteId.current);
        
        // Leave WebSocket room for previous note
        if (isWebSocketActive) {
          webSocketManager.leaveNote(currentNoteId.current);
        }
        
        syncService.clearNotePending(currentNoteId.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      if (realtimeUpdateTimeoutRef.current) {
        clearTimeout(realtimeUpdateTimeoutRef.current);
        realtimeUpdateTimeoutRef.current = null;
      }
      
      stopLegacyPolling();
      
      setIsInitializing(true);
      editorReadyRef.current = false;
      userInteractedRef.current = false;
      
      const newTitle = note.title || '';
      const newContent = note.content || '';
      const timestamp = note.updatedAt;
      
      currentNoteId.current = note.id;
      initialValues.current = { title: newTitle, content: newContent };
      
      noteTimestampRef.current = timestamp;
      
      setTitle(newTitle);
      setLastSaved(new Date(note.updatedAt));
      setHasUnsavedChanges(false);
      setIsLocked(false);
      setLockError('');
      setRealtimeEnabled(false);
      
      setLastUpdateTimestamp(timestamp);
      
      if (note.locked && note.lockedBy) {
        setLockOwner(note.lockedBy);
        setLockError(`Note is being edited by another user`);
        
        // Start polling for lock release
        startLockPolling(note.id);
      } else {
        setLockOwner(null);
        
        // Stop polling if note is not locked
        stopLockPolling();
      }
      
      // Set editor content immediately to prevent flash
      if (editor) {
        // Set content immediately
        editor.commands.setContent(newContent || '');
        
        // Initialize stable baseline for pause-based diff system
        const initialContent = newContent || '';
        stableBaselineRef.current = initialContent;
        saveStateRef.current.canSave = true;
        
        // Use minimal delay for state updates
        setTimeout(() => {
          setIsInitializing(false);
          editorReadyRef.current = true;
          
          // Position cursor at the beginning immediately after initialization
          if (currentNoteId.current === note.id) {
            try {
              // Set the cursor position without focus (CSS will make it visible)
              editor.view.dispatch(
                editor.view.state.tr.setSelection(
                  editor.view.state.selection.constructor.atStart(editor.view.state.doc)
                )
              );
              console.log('📍 Positioned cursor at beginning of document (CSS makes it visible)');
              
            } catch (error) {
              console.log('⚠️ Failed to position initial cursor:', error);
          }
          
          // CRITICAL: Use the normalized content from the editor as the baseline
          // This prevents false "changes" when editor auto-normalizes content
          const normalizedContent = editor.getHTML();
          console.log('🔧 Setting initial values with normalized content:', {
            originalLength: newContent?.length || 0,
            normalizedLength: normalizedContent.length,
            contentDiffers: newContent !== normalizedContent
          });
          
          initialValues.current = { 
            title: newTitle, 
            content: normalizedContent  // Use normalized content, not original
          };
          
          // Initialize collaboration after state is stable
          setTimeout(async () => {
            if (currentUser) {
              console.log('🤝 Initializing collaboration for note:', note.id);
              
              // Always use WebSocket for ALL notes - much better UX and consistency
              if (isWebSocketActive) {
                console.log('🔌 Joining note via WebSocket (all notes use real-time sync)');
                await webSocketManager.joinNote(note.id);
                setRealtimeEnabled(true);
              } else {
                console.log('📡 WebSocket not available, using HTTP fallback');
                // Fallback to HTTP-based presence for shared notes only
                const isSharedNote = note.shared || note.hasBeenShared;
                if (isSharedNote) {
                        try {
                          await api.post(`/api/notes/${note.id}/presence`, {
                            action: 'join',
                            editorInfo: {
                              name: currentUser.name,
                              avatar: currentUser.avatar
                            }
                          });
                          console.log('✅ HTTP presence registration successful');
                        } catch (error) {
                          console.warn('HTTP presence registration failed:', error);
                        }
                        
                        // Start HTTP polling for shared notes when WebSocket unavailable
                        startLegacyPolling();
                      }
                    }
                    
                    // Immediate sync check for all notes
                    console.log('⚡ Triggering immediate sync for note');
                    setTimeout(() => {
                      if (isWebSocketActive) {
                        webSocketManager.sendHeartbeat(note.id);
                      } else {
                        checkForUpdates();
                      }
                  }, 1000);
                }
              }, 50); // Reduced from 200ms to 50ms
            }
          }, 10); // Reduced from 100ms to 10ms
      }
      
    } else if (!note) {
      console.log('🗑️ No note selected, cleaning up');
      // Cleanup when no note
      if (currentNoteId.current) {
        releaseLock(currentNoteId.current);
        
        // Leave WebSocket room
        if (webSocketManager.getState().connected) {
          webSocketManager.leaveNote(currentNoteId.current);
        }
        
        syncService.clearNotePending(currentNoteId.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      if (realtimeUpdateTimeoutRef.current) {
        clearTimeout(realtimeUpdateTimeoutRef.current);
        realtimeUpdateTimeoutRef.current = null;
      }
      
      stopLegacyPolling();
      stopLockPolling();
      
      setTitle('');
      if (editor) {
        editor.commands.setContent('');
      }
      setLastSaved(null);
      setLastUpdateTimestamp(null);
      noteTimestampRef.current = null;
      setHasUnsavedChanges(false);
      setIsLocked(false);
      setLockError('');
      setLockOwner(null);
      setIsInitializing(false);
      setActiveEditors([]);
      setRealtimeEnabled(false);
      initialValues.current = { title: '', content: '' };
      currentNoteId.current = null;
      editorReadyRef.current = false;
      userInteractedRef.current = false;
    }
  }, [
    note, 
    releaseLock, 
    editor, 
    currentUser,
    stopLegacyPolling,
    startLegacyPolling,
    checkForUpdates
  ]);

  // Handle content updates for the current note (from sync, WebSocket, etc.)
  useEffect(() => {
    console.log('🔍 [DEBUG] useEffect triggered - checking note prop changes:', {
      hasNote: !!note,
      hasEditor: !!editor,
      isInitializing,
      applyingRemoteChanges: applyingRemoteChangesRef.current,
      noteId: note?.id,
      currentNoteId: currentNoteId.current,
      noteUpdatedAt: note?.updatedAt,
      noteTimestampRef: noteTimestampRef.current,
      userInteracted: userInteractedRef.current
    });

    // Only update if we have the same note but content/timestamp changed
    if (!note || !editor || isInitializing || applyingRemoteChangesRef.current) {
      console.log('🚫 [DEBUG] Early return due to conditions:', {
        noNote: !note,
        noEditor: !editor,
        isInitializing,
        applyingRemoteChanges: applyingRemoteChangesRef.current
      });
      return;
    }
    
    // Check if this is the same note but with updated content
    const isSameNote = note.id === currentNoteId.current;
    const timestampChanged = note.updatedAt !== noteTimestampRef.current;
    
    console.log('🔍 [DEBUG] Note comparison:', {
      isSameNote,
      timestampChanged,
      noteId: note.id,
      currentNoteId: currentNoteId.current,
      noteUpdatedAt: note.updatedAt,
      refTimestamp: noteTimestampRef.current
    });
    
    if (isSameNote && timestampChanged) {
      const currentEditorContent = editor.getHTML();
      const newContent = note.content || '';
      
      // Use shared normalization function to prevent false positives from whitespace/encoding differences
      
      const normalizedNew = normalizeContent(newContent);
      const normalizedCurrent = normalizeContent(currentEditorContent);
      const contentDiffers = normalizedNew !== normalizedCurrent;
      const userNotInteracted = !userInteractedRef.current;
      const recentCheckboxInteraction = (Date.now() - recentCheckboxInteractionRef.current) < 2000; // Within 2 seconds
      
      // Accept remote updates in these cases:
      // 1. User hasn't interacted at all
      // 2. Content differs significantly (suggesting remote change from another device)
      // 3. Timestamp is much newer (suggesting device was offline and missed updates)
      // 4. CRITICAL: Always accept during bulk sync operations (offline->online recovery)
      // 5. TIMING FIX: Accept if bulk sync completed recently (within last 5 seconds)
      const timestampAge = new Date(note.updatedAt) - new Date(noteTimestampRef.current);
      const significantTimestampDiff = timestampAge > 30000; // 30 seconds
      const recentBulkSync = recentBulkSyncRef.current && (Date.now() - recentBulkSyncRef.current) < 5000; // Within 5 seconds
      const shouldAcceptRemoteUpdate = userNotInteracted || significantTimestampDiff || bulkSyncInProgress || appResumeSync || recentBulkSync;
      
      console.log('🔍 [DEBUG] Content comparison:', {
        contentDiffers,
        userNotInteracted,
        timestampAge,
        significantTimestampDiff,
        bulkSyncInProgress,
        appResumeSync,
        recentBulkSync,
        recentBulkSyncTimestamp: recentBulkSyncRef.current,
        timeSinceLastBulkSync: recentBulkSyncRef.current ? Date.now() - recentBulkSyncRef.current : null,
        shouldAcceptRemoteUpdate,
        rawCurrentLength: currentEditorContent.length,
        rawNewLength: newContent.length,
        normalizedCurrentLength: normalizedCurrent.length,
        normalizedNewLength: normalizedNew.length,
        normalizedDifference: contentDiffers ? 'Content differs after normalization' : 'Content identical after normalization',
        currentContentPreview: currentEditorContent.substring(0, 100) + '...',
        newContentPreview: newContent.substring(0, 100) + '...',
        userInteractedRef: userInteractedRef.current,
        acceptReason: shouldAcceptRemoteUpdate ? (userNotInteracted ? 'user not interacted' : significantTimestampDiff ? 'significant timestamp diff' : (bulkSyncInProgress || appResumeSync) ? 'bulk sync in progress' : recentBulkSync ? 'recent bulk sync' : 'unknown') : 'none'
      });
      
      if (contentDiffers && shouldAcceptRemoteUpdate) {
        console.log('✅ [DEBUG] All conditions met - updating editor content!');
        console.log('🔄 Updating editor content from external source:', {
          noteId: note.id,
          oldTimestamp: noteTimestampRef.current,
          newTimestamp: note.updatedAt,
          contentChanged: newContent !== currentEditorContent
        });
        
        applyingRemoteChangesRef.current = true;
        
        // PRESERVE SCROLL POSITION during content updates - use tracked position
        const editorElement = editor?.view?.dom;
        const scrollContainer = editorElement?.closest('.MuiBox-root') || editorElement?.parentElement;
        const scrollTop = lastKnownScrollPositionRef.current || scrollContainer?.scrollTop || 0;
        
        console.log('📍 [EXTERNAL UPDATE] Preserving scroll position:', scrollTop, '(tracked:', lastKnownScrollPositionRef.current, ', current:', scrollContainer?.scrollTop, ')');
        
        // Update the editor content
        editor.commands.setContent(newContent);
        
        // Update stable baseline when applying remote changes
        stableBaselineRef.current = newContent;
        saveStateRef.current.canSave = true;
        
        // Restore scroll position after content update
        setTimeout(() => {
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollTop;
            console.log('📍 [EXTERNAL UPDATE] Restored scroll position:', scrollTop);
          }
        }, 10);
        
        // Update our tracking values
        noteTimestampRef.current = note.updatedAt;
        initialValues.current.content = newContent;
        setLastSaved(new Date(note.updatedAt));
        setLastUpdateTimestamp(note.updatedAt);
        
        // Clear the flag after a brief delay
        setTimeout(() => {
          applyingRemoteChangesRef.current = false;
        }, 100);
      } else if (contentDiffers && recentCheckboxInteraction) {
        console.log('📍 [DEBUG] Preserving scroll position for recent checkbox interaction even though not accepting remote update');
        
        // PRESERVE SCROLL POSITION for checkbox interactions - use tracked position
        const editorElement = editor?.view?.dom;
        const scrollContainer = editorElement?.closest('.MuiBox-root') || editorElement?.parentElement;
        const scrollTop = lastKnownScrollPositionRef.current || scrollContainer?.scrollTop || 0;
        
        console.log('📍 [CHECKBOX] Preserving scroll position:', scrollTop, '(tracked:', lastKnownScrollPositionRef.current, ', current:', scrollContainer?.scrollTop, ')');
        
        // Apply a brief timeout to allow the content to stabilize, then preserve scroll
        setTimeout(() => {
          if (scrollContainer && scrollTop > 0) {
            scrollContainer.scrollTop = scrollTop;
            console.log('📍 [CHECKBOX] Restored scroll position:', scrollTop);
          }
        }, 50);
        
      } else {
        console.log('🚫 [DEBUG] Content update blocked:', {
          contentDiffers,
          userNotInteracted,
          timestampAge,
          significantTimestampDiff,
          shouldAcceptRemoteUpdate,
          recentCheckboxInteraction,
          reason: !contentDiffers ? 'Content is the same' : 'User has interacted recently and timestamp diff is not significant'
        });
      }
    } else {
      console.log('🚫 [DEBUG] Note update skipped:', {
        isSameNote,
        timestampChanged,
        reason: !isSameNote ? 'Different note' : 'Timestamp unchanged'
      });
    }
  }, [note, editor, isInitializing]);

  // Enhanced presence checking for shared notes (fallback when WebSocket unavailable)
  useEffect(() => {
    // Only run HTTP-based presence checking when WebSocket is NOT active
    if (note?.id && currentUser && !isWebSocketActive) {
      const isCollaborativeNote = note.shared || note.hasBeenShared;
      // Reduced frequency since WebSocket should handle most cases
      const checkInterval = isCollaborativeNote ? 90000 : 180000; // 1.5-3 minutes
      
      presenceIntervalRef.current = setInterval(async () => {
        // Double-check WebSocket isn't active
        if (isWebSocketActive) {
          console.log('⚠️ WebSocket became active, stopping HTTP presence checks');
          clearInterval(presenceIntervalRef.current);
          return;
        }
        
        try {
          await checkActiveEditors();
        } catch (error) {
          if (error.response?.status !== 429 && error.response?.status !== 500) {
            console.error('❌ Presence check failed:', error);
          }
        }
      }, checkInterval);
      
      return () => {
        if (presenceIntervalRef.current) {
          clearInterval(presenceIntervalRef.current);
        }
      };
    }
  }, [note?.id, note?.shared, note?.hasBeenShared, currentUser, checkActiveEditors, isWebSocketActive]);

  // Watch for editor content changes and auto-save
  useEffect(() => {
    if (isInitializing || !editorReadyRef.current || !userInteractedRef.current || !editor) {
      return;
    }
    
    if (note && currentNoteId.current === note.id) {
      const hasChanges = checkForChanges();
      
      setHasUnsavedChanges(hasChanges);
      
      if (hasChanges && !applyingRemoteChangesRef.current) {
        if (!isLocked && !lockOwner && note.permission === 'edit') {
          acquireLock(note.id);
        }
        
        if (isLocked || !lockOwner) {
          if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
          }
          
          saveTimeoutRef.current = setTimeout(() => {
            if (applyingRemoteChangesRef.current) {
              console.log('🔄 Skipping auto-save - applying remote changes');
              saveTimeoutRef.current = null;
              return;
            }

            // Skip auto-save if real-time updates are active (new pause-based diff system)
            if (isWebSocketActive) {
              console.log('⚡ Skipping auto-save - real-time WebSocket active (pause-based diff system handles saves)');
              saveTimeoutRef.current = null;
              return;
            }
            
            const updates = {};
            const currentTitle = title || '';
            const initialTitle = initialValues.current.title || '';
            if (currentTitle !== initialTitle) {
              updates.title = title;
            }
            
            const currentContent = getCurrentContent();
            const initialContent = initialValues.current.content || '';
            if (currentContent !== initialContent) {
              updates.content = currentContent;
            }
            
            if (Object.keys(updates).length > 0) {
              console.log('💾 Auto-saving changes:', updates);
              saveNote(note.id, updates);
            }
            saveTimeoutRef.current = null;
          }, 3000);
        }
      } else {
        if (isLocked) {
          if (lockTimeoutRef.current) {
            clearTimeout(lockTimeoutRef.current);
          }
          lockTimeoutRef.current = setTimeout(() => {
            releaseLock(note.id);
            lockTimeoutRef.current = null;
          }, 10000);
        }
      }
    }

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
      }
    };
  }, [title, editor?.getHTML(), note, isInitializing, checkForChanges, saveNote, isLocked, lockOwner, acquireLock, releaseLock, getCurrentContent, editor]);

  // Set editor editability
  useEffect(() => {
    if (editor) {
      const canEdit = note?.permission === 'edit' && !lockOwner;
      editor.setEditable(canEdit);
    }
  }, [editor, note?.permission, lockOwner]);

  // Setup drag and drop listeners
  useEffect(() => {
    if (!editor) return;

    const editorElement = editor.view.dom;
    
    editorElement.addEventListener('dragenter', handleDragEnter);
    editorElement.addEventListener('dragleave', handleDragLeave);
    editorElement.addEventListener('dragover', handleDragOver);
    editorElement.addEventListener('drop', handleDrop);

    return () => {
      editorElement.removeEventListener('dragenter', handleDragEnter);
      editorElement.removeEventListener('dragleave', handleDragLeave);
      editorElement.removeEventListener('dragover', handleDragOver);
      editorElement.removeEventListener('drop', handleDrop);
    };
  }, [editor, handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  // Sync lockStateRef with isLocked state
  useEffect(() => {
    lockStateRef.current = { isLocked };
  }, [isLocked]);

  // Bulk sync periodic trigger for collaborative notes (reduced frequency due to WebSocket)
  useEffect(() => {
    if (!note?.id || (!note.shared && !note.hasBeenShared) || !currentUser) {
      return;
    }
    
    // Trigger periodic bulk sync for shared notes - increased interval since WebSocket handles real-time
    const bulkSyncInterval = setInterval(() => {
      const timeSinceLastBulkSync = lastBulkSyncTimeRef.current 
        ? Date.now() - lastBulkSyncTimeRef.current 
        : Infinity;
      
      // Increased from 30 seconds to 2 minutes since WebSocket provides real-time updates
      if (timeSinceLastBulkSync > 120000 && !bulkSyncInProgress) {
        console.log('⏰ Periodic bulk sync triggered for collaborative note');
        handleManualBulkSync();
      }
    }, 60000); // Check every minute instead of 20 seconds
    
    return () => clearInterval(bulkSyncInterval);
  }, [note?.id, note?.shared, note?.hasBeenShared, currentUser, bulkSyncInProgress, handleManualBulkSync]);
  
  // NEW: WebSocket event handling for server confirmations
  useEffect(() => {
    if (!isWebSocketActive) return;
    
    const handleBatchSaved = (data) => {
      if (data.noteId === note?.id && data.success) {
        devLog('✅ [WEBSOCKET] Server saved batch:', data);
        
        // Use confirmed content from server
        const confirmedContent = data.confirmedContent || editor?.getHTML() || '';
        
        // Use confirmed content from server as the new stable baseline
        handleServerConfirmation(confirmedContent);
        
        devLog('🔄 [BASELINE] Stable baseline updated with server-confirmed content');
      }
    };
    
    // Listen for batch-saved events from server
    const socket = webSocketManager.socket;
    if (socket) {
      socket.on('batch-saved', handleBatchSaved);
      
      return () => {
        socket.off('batch-saved', handleBatchSaved);
      };
    }
  }, [isWebSocketActive, note?.id, editor, handleServerConfirmation]);

  // Enhanced cleanup on unmount
  useEffect(() => {
    return () => {
      // Clear any pending typing timeouts
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      
      if (currentNoteId.current) {
        releaseLock(currentNoteId.current);
        
        // Leave WebSocket room
        if (webSocketManager.getState().connected) {
          webSocketManager.leaveNote(currentNoteId.current);
        }
        
        syncService.clearNotePending(currentNoteId.current);
      }
      if (lockExtensionIntervalRef.current) {
        clearInterval(lockExtensionIntervalRef.current);
      }
      if (lockPollingIntervalRef.current) {
        clearInterval(lockPollingIntervalRef.current);
      }
      if (presenceIntervalRef.current) {
        clearInterval(presenceIntervalRef.current);
      }
      if (bulkSyncTimeoutRef.current) {
        clearTimeout(bulkSyncTimeoutRef.current);
      }
      if (realtimeUpdateTimeoutRef.current) {
        clearTimeout(realtimeUpdateTimeoutRef.current);
      }
      
      // Cleanup injected CSS
      const checkboxStyle = document.getElementById('checkbox-keyboard-prevention');
      if (checkboxStyle) {
        checkboxStyle.remove();
      }
      
      stopLegacyPolling();
    };
  }, [releaseLock, stopLegacyPolling]);

  // ===== RENDER =====
  if (!note) {
    return (
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
    );
  }

  const canEdit = note.permission === 'edit' && !lockOwner;
  const isShared = note.shared || note.hasBeenShared || false;

  return (
    <Box sx={{ 
      flexGrow: 1, 
      display: 'flex', 
      flexDirection: 'column',
      overflow: 'hidden',
      minWidth: 0,
      height: '100%',
      backgroundColor: 'background.default'
    }}>
      {/* Mobile Header */}
      {isMobile && (
        <AppBar 
          position="static" 
          elevation={0} 
          sx={{ 
            backgroundColor: 'background.paper',
            color: 'text.primary',
            borderBottom: 1,
            borderColor: 'divider'
          }}
        >
          <Toolbar sx={{ minHeight: '56px !important', px: 1 }}>
            <IconButton
              edge="start"
              onClick={handleBack}
              sx={{ mr: 1 }}
            >
              <ArrowBackIcon />
            </IconButton>
            
            <Typography 
              variant="h6" 
              sx={{ 
                flexGrow: 1,
                fontSize: '1.125rem',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {title || 'Untitled'}
            </Typography>
            
            {/* Mobile status indicators */}
            <Box display="flex" gap={0.5} alignItems="center">
              {/* NEW: WebSocket status */}
              {isWebSocketActive && realtimeEnabled && (
                <Tooltip title="Real-time collaboration active">
                  <RealtimeIcon color="success" fontSize="small" />
                </Tooltip>
              )}
              
              {isWebSocketActive && !realtimeEnabled && (
                <Tooltip title="WebSocket connected">
                  <WifiIcon color="info" fontSize="small" />
                </Tooltip>
              )}
              
              {!isWebSocketActive && connectionMode !== 'offline' && (
                <Tooltip title="Using HTTP fallback">
                  <WifiOffIcon color="warning" fontSize="small" />
                </Tooltip>
              )}
              
              {bulkSyncInProgress && (
                <Tooltip title="Syncing all notes">
                  <RefreshIcon color="info" fontSize="small" className="rotating" />
                </Tooltip>
              )}
              
              {syncingChanges && <SyncIcon color="primary" fontSize="small" className="rotating" />}
              {saving && <SaveIcon color="primary" fontSize="small" />}
              {hasUnsavedChanges && !saving && (
                <Chip label="●" size="small" color="warning" sx={{ minWidth: 8, height: 8, '& .MuiChip-label': { px: 0 } }} />
              )}
              
              {isLocked && (
                <LockOpenIcon color="primary" fontSize="small" />
              )}
              
              {isShared && (
                <PeopleIcon color="secondary" fontSize="small" />
              )}
              
              {note.permission === 'edit' && !note.sharedBy && (
                <IconButton
                  onClick={() => setShareDialogOpen(true)}
                  size="small"
                  sx={{ p: 0.5 }}
                >
                  <ShareIcon fontSize="small" />
                </IconButton>
              )}
              
              {isShared && (
                <IconButton
                  onClick={handleManualBulkSync}
                  disabled={bulkSyncInProgress}
                  size="small"
                  sx={{ p: 0.5 }}
                  title="Sync all notes"
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
          </Toolbar>
        </AppBar>
      )}

      <Box sx={{ 
        flexGrow: 1, 
        display: 'flex', 
        flexDirection: 'column',
        overflow: 'hidden',
        p: isMobile ? 0 : 2
      }}>
        <Paper
          sx={{
            flexGrow: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
            m: isMobile ? 0 : 1,
            p: isMobile ? 1 : 3,
            borderRadius: isMobile ? 0 : 1,
            boxShadow: isMobile ? 'none' : 1
          }}
        >
          {/* Fixed-height consolidated status area to prevent layout shifts */}
          <Box 
            sx={{ 
              minHeight: '56px', // Reserve fixed space to prevent layout shift
              mb: 2,
              '& .MuiAlert-root': {
                transition: 'all 0.3s ease-in-out',
              }
            }}
          >
            {/* Priority-based message display (only one message shown at a time) */}
            {lockError ? (
              /* Priority 1: Lock errors (highest priority) */
              <Alert severity="warning" sx={{ mb: 1 }} icon={<WarningIcon />}>
                {lockError}
              </Alert>
            ) : (bulkSyncInProgress || appResumeSync) ? (
              /* Priority 2: Active sync operations */
              <Alert severity="info" sx={{ mb: 1 }}>
                {appResumeSync 
                  ? 'Checking for updates after app resume...'
                  : 'Syncing all notes for recent changes...'
                }
              </Alert>
            ) : bulkSyncResults ? (
              /* Priority 3: Sync results */
              <Alert 
                severity={bulkSyncResults.conflicts.length > 0 ? "warning" : "success"} 
                sx={{ mb: 1 }}
              >
                {bulkSyncResults.updatedNotes.length > 0 && 
                  `Updated ${bulkSyncResults.updatedNotes.length} notes. `
                }
                {bulkSyncResults.conflicts.length > 0 && 
                  `${bulkSyncResults.conflicts.length} conflicts require attention. `
                }
                {bulkSyncResults.updatedNotes.length === 0 && bulkSyncResults.conflicts.length === 0 && 
                  'All notes are up to date.'
                }
              </Alert>
            ) : hasRemoteChanges ? (
              /* Priority 4: Recent updates */
              <Alert severity="success" sx={{ mb: 1 }}>
                Note updated with recent changes from collaborators
              </Alert>
            ) : showCollaborationAlert && activeEditors.length > 0 ? (
              /* Priority 5: Active collaboration */
              <Alert 
                severity="info" 
                sx={{ mb: 1 }}
                icon={
                  <AvatarGroup max={3} sx={{ '& .MuiAvatar-root': { width: 20, height: 20, fontSize: '0.7rem' } }}>
                    {activeEditors.map(editor => (
                      <Avatar key={editor.connectionId} sx={{ bgcolor: 'primary.main' }}>
                        {editor.name.charAt(0).toUpperCase()}
                      </Avatar>
                    ))}
                  </AvatarGroup>
                }
              >
                <Box>
                  {activeEditors.length === 1 
                    ? `${activeEditors[0].name} is also editing this note${activeEditors[0].connectionCount > 1 ? ` (${activeEditors[0].connectionCount} connections)` : ''}`
                    : `${activeEditors.length} others are editing this note`
                  }
                  <Typography variant="caption" display="block" sx={{ mt: 0.5, opacity: 0.8 }}>
                    Real-time collaboration active
                  </Typography>
                </Box>
              </Alert>
            ) : isWebSocketActive && realtimeEnabled ? (
              /* Priority 6: Connection status (quiet state) */
              <Alert severity="success" sx={{ mb: 1, opacity: 0.7 }} icon={<RealtimeIcon />}>
                <Box>
                  Real-time sync active
                  {lastRealtimeUpdate && (
                    <Typography variant="caption" display="block" sx={{ mt: 0.5, opacity: 0.8 }}>
                      Last update: {formatSaveTime(lastRealtimeUpdate)}
                    </Typography>
                  )}
                </Box>
              </Alert>
            ) : !isWebSocketActive && isShared ? (
              /* Fallback: HTTP mode notice */
              <Alert severity="info" sx={{ mb: 1, opacity: 0.7 }} icon={<WifiOffIcon />}>
                Using HTTP sync mode - updates check every 10 seconds
              </Alert>
            ) : null}
          </Box>

          {/* Desktop Header */}
{!isMobile && (
  <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
    <TextField
      fullWidth
      variant="outlined"
      placeholder="Note title..."
      value={title}
      onChange={handleTitleChange}
      onFocus={handleTitleFocus}
      disabled={!canEdit}
      sx={{
        '& .MuiOutlinedInput-root': {
          fontSize: '1.5rem',
          fontWeight: 500,
        },
      }}
    />

              {/* Status chips */}
              <Box display="flex" gap={1} alignItems="center" flexShrink={0}>
                {/* NEW: WebSocket status indicators */}
                {isWebSocketActive && realtimeEnabled && (
                  <Chip 
                    label="Real-time" 
                    size="small" 
                    color="success" 
                    icon={<RealtimeIcon />}
                  />
                )}
                
                {isWebSocketActive && !realtimeEnabled && (
                  <Chip 
                    label="WebSocket" 
                    size="small" 
                    color="info" 
                    icon={<WifiIcon />}
                  />
                )}
                
                {!isWebSocketActive && isShared && (
                  <Chip 
                    label="HTTP sync" 
                    size="small" 
                    color="warning" 
                    icon={<WifiOffIcon />}
                  />
                )}
                
                {bulkSyncInProgress && (
                  <Chip 
                    label="Syncing all..." 
                    size="small" 
                    color="info" 
                    icon={<RefreshIcon className="rotating" />}
                  />
                )}
                
                {syncingChanges && (
                  <Chip 
                    label="Syncing..." 
                    size="small" 
                    color="info" 
                    icon={<SyncIcon className="rotating" />}
                  />
                )}
                {saving && <Chip label="Saving..." size="small" color="primary" />}
                {hasUnsavedChanges && !saving && (
                  <Chip label="Unsaved changes" size="small" color="warning" variant="outlined" />
                )}
                {lastSaved && !saving && !hasUnsavedChanges && (
                  <Chip
                    label={`Saved ${formatSaveTime(lastSaved)}`}
                    size="small"
                    color="success"
                    variant="outlined"
                  />
                )}
                
                {/* Lock status */}
                {isLocked && (
                  <Tooltip title="You have editing lock">
                    <Chip
                      icon={<LockOpenIcon />}
                      label="Editing"
                      size="small"
                      color="primary"
                    />
                  </Tooltip>
                )}
                
                {/* Shared indicator */}
                {isShared && (
                  <Tooltip title={
                    note.sharedBy 
                      ? `Shared by ${note.sharedBy}` 
                      : note.hasBeenShared 
                        ? `Shared with ${note.sharedWith?.length || 0} ${note.sharedWith?.length === 1 ? 'person' : 'people'}`
                        : 'Shared note'
                  }>
                    <Chip
                      icon={<PeopleIcon />}
                      label="Shared"
                      size="small"
                      color="secondary"
                    />
                  </Tooltip>
                )}
                
                {/* Active editors */}
                {activeEditors.length > 0 && (
                  <Tooltip title={`${activeEditors.length} ${activeEditors.length === 1 ? 'person' : 'people'} editing`}>
                    <AvatarGroup max={3} sx={{ '& .MuiAvatar-root': { width: 28, height: 28 } }}>
                      {activeEditors.map(editor => (
                        <Avatar key={editor.id} src={editor.avatar} sx={{ width: 28, height: 28 }}>
                          {editor.name?.charAt(0)}
                        </Avatar>
                      ))}
                    </AvatarGroup>
                  </Tooltip>
                )}
                
                {/* Manual bulk sync button */}
                {isShared && (
                  <Tooltip title="Sync all notes">
                    <IconButton
                      onClick={handleManualBulkSync}
                      disabled={bulkSyncInProgress}
                      color="default"
                      size="small"
                    >
                      <RefreshIcon />
                    </IconButton>
                  </Tooltip>
                )}
                
                {/* Share button */}
                {note.permission === 'edit' && !note.sharedBy && (
                  <Tooltip title="Share note">
                    <IconButton
                      onClick={() => setShareDialogOpen(true)}
                      color="primary"
                      size="small"
                    >
                      <ShareIcon />
                    </IconButton>
                  </Tooltip>
                )}

      <Tooltip title="Close note">
        <IconButton
          onClick={handleBack}
          color="default"
          size="small"
          sx={{
            '&:hover': {
              bgcolor: 'action.hover',
            }
          }}
        >
          <CloseIcon />
        </IconButton>
      </Tooltip>

              </Box>
            </Box>
          )}

          {/* Mobile Title Field */}
          {isMobile && (
            <TextField
              fullWidth
              variant="outlined"
              placeholder="Note title..."
              value={title}
              onChange={handleTitleChange}
              onFocus={handleTitleFocus}
              disabled={!canEdit}
              sx={{
                mb: 2,
                '& .MuiOutlinedInput-root': {
                  fontSize: '1.25rem',
                  fontWeight: 500,
                },
                '& .MuiOutlinedInput-input': {
                  padding: '12px 14px',
                },
              }}
            />
          )}

          {/* Tiptap Editor */}
          <Box 
            sx={{ 
              flexGrow: 1, 
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              height: isMobile ? 'calc(100% - 80px)' : 'calc(100% - 120px)',
              position: 'relative'
            }}
          >
            {/* Drag overlay */}
            {dragOver && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: 'rgba(25, 118, 210, 0.1)',
                  border: '2px dashed #1976d2',
                  borderRadius: 1,
                  zIndex: 1000,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none'
                }}
              >
                <Box textAlign="center">
                  <UploadIcon sx={{ fontSize: 48, color: 'primary.main', mb: 1 }} />
                  <Typography variant="h6" color="primary.main">
                    Drop images here to upload
                  </Typography>
                </Box>
              </Box>
            )}

            <Paper variant="outlined" sx={{ 
              flexGrow: 1,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 1,
              overflow: 'hidden'
            }}>
              {/* Toolbar - keeping the existing enhanced toolbar implementation */}
              {canEdit && (
                <Box sx={{ 
                  borderBottom: 1, 
                  borderColor: 'divider',
                  p: 1,
                  display: 'flex',
                  flexDirection: isMobile ? 'column' : 'row',
                  gap: 0.5,
                  flexWrap: isMobile ? 'nowrap' : 'wrap',
                  alignItems: 'center'
                }}>
                  {/* DESKTOP: All tools in one row */}
                  {!isMobile && (
                    <>
                      {/* Undo/Redo */}
                      <ButtonGroup size="small" variant="outlined">
                        <Tooltip title="Undo (Ctrl+Z)">
                          <span>
                            <IconButton
                              size="small"
                              onClick={handleUndo}
                              disabled={!editor?.can().undo()}
                            >
                              <UndoIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Redo (Ctrl+Y)">
                          <span>
                            <IconButton
                              size="small"
                              onClick={handleRedo}
                              disabled={!editor?.can().redo()}
                            >
                              <RedoIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </ButtonGroup>
                      
                      <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                      
                      {/* Core formatting */}
                      <ButtonGroup size="small" variant="outlined">
                        <Tooltip title="Bold (Ctrl+B)">
                          <IconButton
                            size="small"
                            onClick={handleBold}
                            color={editor?.isActive('bold') ? 'primary' : 'default'}
                          >
                            <BoldIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Italic (Ctrl+I)">
                          <IconButton
                            size="small"
                            onClick={handleItalic}
                            color={editor?.isActive('italic') ? 'primary' : 'default'}
                          >
                            <ItalicIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Underline (Ctrl+U)">
                          <IconButton
                            size="small"
                            onClick={handleUnderline}
                            color={editor?.isActive('underline') ? 'primary' : 'default'}
                          >
                            <UnderlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Strikethrough">
                          <IconButton
                            size="small"
                            onClick={handleStrikethrough}
                            color={editor?.isActive('strike') ? 'primary' : 'default'}
                          >
                            <StrikethroughIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </ButtonGroup>
                      
                      <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                      
                      {/* Lists */}
                      <ButtonGroup size="small" variant="outlined">
                        <Tooltip title="Bullet List">
                          <IconButton
                            size="small"
                            onClick={handleBulletList}
                            color={editor?.isActive('bulletList') ? 'primary' : 'default'}
                          >
                            <BulletIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Numbered List">
                          <IconButton
                            size="small"
                            onClick={handleOrderedList}
                            color={editor?.isActive('orderedList') ? 'primary' : 'default'}
                          >
                            <NumberIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Task List">
                          <IconButton
                            size="small"
                            onClick={handleTaskList}
                            color={editor?.isActive('taskList') ? 'primary' : 'default'}
                          >
                            <CheckboxIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </ButtonGroup>
                      
                      <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                      
                      {/* Advanced formatting */}
                      <ButtonGroup size="small" variant="outlined">
                        <Tooltip title="Quote">
                          <IconButton
                            size="small"
                            onClick={handleBlockquote}
                            color={editor?.isActive('blockquote') ? 'primary' : 'default'}
                          >
                            <QuoteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Code Block">
                          <IconButton
                            size="small"
                            onClick={handleCodeBlock}
                            color={editor?.isActive('codeBlock') ? 'primary' : 'default'}
                          >
                            <CodeIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Link (Ctrl+K)">
                          <IconButton
                            size="small"
                            onClick={handleLink}
                            color={editor?.isActive('link') ? 'primary' : 'default'}
                          >
                            <LinkIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        <Tooltip title="Insert Image">
                          <IconButton
                            size="small"
                            onClick={handleImageButton}
                          >
                            <ImageIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </ButtonGroup>
                    </>
                  )}

                  {/* MOBILE: Two-tier collapsible approach */}
                  {isMobile && (
                    <>
                      {/* Primary toolbar - always visible on mobile */}
                      <Box sx={{
                        display: 'flex',
                        gap: 0.5,
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        minWidth: 0,
                        width: '100%'
                      }}>
                        {/* Essential tools container */}
                        <Box sx={{
                          display: 'flex',
                          gap: 0.5,
                          alignItems: 'center',
                          overflow: 'hidden',
                          minWidth: 0,
                          flex: 1,
                        }}>
                          {/* Undo/Redo group */}
                          <ButtonGroup size="small" variant="outlined">
                            <Tooltip title="Undo (Ctrl+Z)">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={handleUndo}
                                  disabled={!editor?.can().undo()}
                                  sx={{ minWidth: 36, minHeight: 36 }}
                                >
                                  <UndoIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="Redo (Ctrl+Y)">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={handleRedo}
                                  disabled={!editor?.can().redo()}
                                  sx={{ minWidth: 36, minHeight: 36 }}
                                >
                                  <RedoIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </ButtonGroup>
                          
                          {/* Core formatting group */}
                          <ButtonGroup size="small" variant="outlined">
                            <Tooltip title="Bold (Ctrl+B)">
                              <IconButton
                                size="small"
                                onClick={handleBold}
                                color={editor?.isActive('bold') ? 'primary' : 'default'}
                                sx={{ minWidth: 36, minHeight: 36 }}
                              >
                                <BoldIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            <Tooltip title="Italic (Ctrl+I)">
                              <IconButton
                                size="small"
                                onClick={handleItalic}
                                color={editor?.isActive('italic') ? 'primary' : 'default'}
                                sx={{ minWidth: 36, minHeight: 36 }}
                              >
                                <ItalicIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </ButtonGroup>
                          
                          {/* Quick actions */}
                          <Box sx={{ display: 'flex', gap: 0.5 }}>
                            <Tooltip title="Bullet List">
                              <IconButton
                                size="small"
                                onClick={handleBulletList}
                                color={editor?.isActive('bulletList') ? 'primary' : 'default'}
                                variant="outlined"
                                sx={{ 
                                  minWidth: 36,
                                  minHeight: 36,
                                  border: '1px solid',
                                  borderColor: 'divider'
                                }}
                              >
                                <BulletIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            <Tooltip title="Insert Image">
                              <IconButton
                                size="small"
                                onClick={handleImageButton}
                                variant="outlined"
                                sx={{ 
                                  minWidth: 36,
                                  minHeight: 36,
                                  border: '1px solid',
                                  borderColor: 'divider'
                                }}
                              >
                                <ImageIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Box>
                        </Box>
                        
                        {/* Expand/collapse toggle */}
                        <Tooltip title={toolbarExpanded ? "Hide extra tools" : "Show more tools"}>
                          <IconButton
                            size="small"
                            onClick={toggleToolbar}
                            color={toolbarExpanded ? 'primary' : 'default'}
                            sx={{
                              minWidth: 36,
                              minHeight: 36,
                              transition: 'all 0.2s ease-in-out',
                              bgcolor: toolbarExpanded ? 'action.selected' : 'transparent',
                              '&:hover': {
                                bgcolor: toolbarExpanded ? 'action.selected' : 'action.hover',
                              }
                            }}
                          >
                            {toolbarExpanded ? 
                              <ExpandLessIcon fontSize="small" /> : 
                              <ExpandMoreIcon fontSize="small" />
                            }
                          </IconButton>
                        </Tooltip>
                      </Box>
                      
                      {/* Secondary toolbar - collapsible on mobile */}
                      <Collapse 
                        in={toolbarExpanded}
                        timeout={300}
                      >
                        <Box sx={{
                          display: 'flex',
                          gap: 0.5,
                          alignItems: 'center',
                          flexWrap: 'nowrap',
                          overflowX: 'auto',
                          overflowY: 'hidden',
                          pb: 0.5,
                          pt: 0.5,
                          width: '100%',
                          // Custom scrollbar for mobile
                          '&::-webkit-scrollbar': {
                            height: 4,
                          },
                          '&::-webkit-scrollbar-track': {
                            background: 'transparent',
                          },
                          '&::-webkit-scrollbar-thumb': {
                            background: 'rgba(0, 0, 0, 0.2)',
                            borderRadius: 2,
                          },
                        }}>
                          {/* Additional formatting */}
                          <ButtonGroup size="small" variant="outlined" sx={{ flexShrink: 0 }}>
                            <Tooltip title="Underline (Ctrl+U)">
                              <IconButton
                                size="small"
                                onClick={handleUnderline}
                                color={editor?.isActive('underline') ? 'primary' : 'default'}
                              >
                                <UnderlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            <Tooltip title="Strikethrough">
                              <IconButton
                                size="small"
                                onClick={handleStrikethrough}
                                color={editor?.isActive('strike') ? 'primary' : 'default'}
                              >
                                <StrikethroughIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </ButtonGroup>
                          
                          <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                          
                          {/* List tools */}
                          <ButtonGroup size="small" variant="outlined" sx={{ flexShrink: 0 }}>
                            <Tooltip title="Numbered List">
                              <IconButton
                                size="small"
                                onClick={handleOrderedList}
                                color={editor?.isActive('orderedList') ? 'primary' : 'default'}
                              >
                                <NumberIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            <Tooltip title="Task List">
                              <IconButton
                                size="small"
                                onClick={handleTaskList}
                                color={editor?.isActive('taskList') ? 'primary' : 'default'}
                              >
                                <CheckboxIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </ButtonGroup>
                          
                          <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                          
                          {/* Advanced formatting */}
                          <ButtonGroup size="small" variant="outlined" sx={{ flexShrink: 0 }}>
                            <Tooltip title="Quote">
                              <IconButton
                                size="small"
                                onClick={handleBlockquote}
                                color={editor?.isActive('blockquote') ? 'primary' : 'default'}
                              >
                                <QuoteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            <Tooltip title="Code Block">
                              <IconButton
                                size="small"
                                onClick={handleCodeBlock}
                                color={editor?.isActive('codeBlock') ? 'primary' : 'default'}
                              >
                                <CodeIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            <Tooltip title="Link (Ctrl+K)">
                              <IconButton
                                size="small"
                                onClick={handleLink}
                                color={editor?.isActive('link') ? 'primary' : 'default'}
                              >
                                <LinkIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </ButtonGroup>
                          
                          {/* Show hint on mobile when expanded */}
                          <Typography 
                            variant="caption" 
                            color="text.secondary" 
                            sx={{ 
                              ml: 2, 
                              flexShrink: 0,
                              opacity: 0.7,
                              fontSize: '0.7rem'
                            }}
                          >
                            Swipe to see more →
                          </Typography>
                        </Box>
                      </Collapse>
                    </>
                  )}
                </Box>
              )}

              {/* Editor Content */}
              <Box sx={{ 
                flexGrow: 1,
                overflow: 'auto',
                '& .ProseMirror': {
                  outline: 'none',
                  '& p.is-editor-empty:first-of-type::before': {
                    content: '"Start writing or drag images here..."',
                    float: 'left',
                    color: 'text.secondary',
                    pointerEvents: 'none',
                    height: 0,
                  },
                  '& h1': { fontSize: '2rem', fontWeight: 600, margin: '1rem 0 0.5rem' },
                  '& h2': { fontSize: '1.75rem', fontWeight: 600, margin: '1rem 0 0.5rem' },
                  '& h3': { fontSize: '1.5rem', fontWeight: 600, margin: '1rem 0 0.5rem' },
                  '& h4': { fontSize: '1.25rem', fontWeight: 600, margin: '1rem 0 0.5rem' },
                  '& h5': { fontSize: '1.125rem', fontWeight: 600, margin: '1rem 0 0.5rem' },
                  '& h6': { fontSize: '1rem', fontWeight: 600, margin: '1rem 0 0.3rem' },
                  '& p': { margin: '0.3rem 0' },
                  '& ul, & ol': { margin: '0.3rem 0', paddingLeft: '1.5rem' },
                  '& .tiptap-task-list': {
                    listStyle: 'none',
                    padding: 0,
                    margin: '0.5rem 0',
                    '& .tiptap-task-item': {
                      display: 'flex',
                      alignItems: 'flex-start',
                      margin: '0.2rem 0',
                      '& > label': {
                        flexShrink: 0,
                        marginRight: '0.5rem',
                        marginTop: '0.1rem', // Better alignment with text
                        userSelect: 'none',
                        '& input[type="checkbox"]': {
                          // Prevent mobile keyboard popup
                          outline: 'none !important',
                          cursor: 'pointer',
                          // Make completely non-focusable
                          tabIndex: -1,
                          pointerEvents: 'auto',
                          // Prevent focus that triggers keyboard
                          '&:focus': {
                            outline: 'none !important',
                            boxShadow: 'none !important',
                          },
                          // Prevent any visual focus indicators
                          '&:focus-visible': {
                            outline: 'none !important',
                            boxShadow: 'none !important',
                          },
                        }
                      },
                      '& > div': {
                        flex: 1,
                        '& > p': {
                          margin: 0,
                        }
                      },
                      '&[data-checked="true"] > div': {
                        textDecoration: 'line-through',
                        opacity: 0.6,
                      }
                    }
                  },
                  '& blockquote': { 
                    borderLeft: '4px solid #e0e0e0', 
                    paddingLeft: '1rem', 
                    margin: '1rem 0',
                    fontStyle: 'italic',
                    color: 'text.secondary'
                  },
                  '& code': { 
                    backgroundColor: '#f5f5f5', 
                    padding: '0.2rem 0.4rem', 
                    borderRadius: '4px',
                    fontSize: '0.9em'
                  },
                  '& pre': { 
                    backgroundColor: '#f5f5f5', 
                    padding: '1rem', 
                    borderRadius: '8px',
                    overflow: 'auto',
                    margin: '1rem 0'
                  },
                  '& .tiptap-link': {
                    color: 'primary.main',
                    textDecoration: 'underline'
                  },
                  '& .tiptap-image': {
                    maxWidth: '100%',
                    height: 'auto',
                    borderRadius: '8px',
                    margin: '0.5rem 0',
                    cursor: 'pointer',
                    transition: 'opacity 0.2s',
                    '&:hover': {
                      opacity: 0.8
                    }
                  }
                }
              }}>
                <EditorContent editor={editor} />
              </Box>
            </Paper>
          </Box>
        </Paper>
      </Box>

      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        accept="image/*"
        multiple
        style={{ display: 'none' }}
      />

      {/* Image Upload Dialog */}
      <Dialog open={imageUploadDialog} onClose={() => setImageUploadDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Insert Images</DialogTitle>
        <DialogContent>
          {imageError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {imageError}
            </Alert>
          )}
          
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Add images to your note. You can also drag and drop images directly into the editor or paste from clipboard.
          </Typography>
          
          {imageUploading && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ mb: 1 }}>
                Uploading... {uploadProgress}%
              </Typography>
              <LinearProgress variant="determinate" value={uploadProgress} />
            </Box>
          )}
          
          <Box sx={{ textAlign: 'center' }}>
            <Button
              variant="contained"
              onClick={() => fileInputRef.current?.click()}
              startIcon={<UploadIcon />}
              disabled={imageUploading}
              size="large"
              sx={{ mb: 2 }}
            >
              Choose Images
            </Button>
          </Box>
          
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center' }}>
            • Maximum 10MB per image<br/>
            • Supports JPG, PNG, GIF, WebP<br/>
            • Up to 5 images at once<br/>
            {!navigator.onLine && '• Images will be stored locally until online'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImageUploadDialog(false)} disabled={imageUploading}>
            {imageUploading ? 'Uploading...' : 'Close'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Enhanced Conflict Resolution Dialog */}
      <Dialog open={conflictDialogOpen} maxWidth="md" fullWidth>
        <DialogTitle>Conflicting Changes Detected</DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ mb: 2 }}>
            Another user ({pendingRemoteUpdate?.lastEditor?.name}) made changes while you were editing. 
            How would you like to resolve this?
          </Typography>
          
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mt: 2 }}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="h6" color="primary">Your Changes</Typography>
              <Typography variant="body2" sx={{ mt: 1, maxHeight: 200, overflow: 'auto' }}>
                Title: {title}<br/>
                Content preview: {getCurrentContent()?.substring(0, 200)}...
              </Typography>
            </Paper>
            
            <Paper sx={{ p: 2 }}>
              <Typography variant="h6" color="secondary">Their Changes</Typography>
              <Typography variant="body2" sx={{ mt: 1, maxHeight: 200, overflow: 'auto' }}>
                Title: {pendingRemoteUpdate?.title}<br/>
                Content preview: {pendingRemoteUpdate?.content?.substring(0, 200)}...
              </Typography>
            </Paper>
          </Box>
        </DialogContent>
        
        <DialogActions>
          <Button onClick={() => handleConflictResolution('accept')} color="secondary">
            Use Their Version
          </Button>
          <Button onClick={() => handleConflictResolution('smart-merge')} color="info">
            Smart Merge
          </Button>
          <Button onClick={() => handleConflictResolution('merge')} color="primary">
            Merge Both
          </Button>
          <Button onClick={() => handleConflictResolution('reject')} variant="contained">
            Keep My Version
          </Button>
        </DialogActions>
      </Dialog>

      <ShareNoteDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        note={note}
        onNoteUpdated={() => {
          window.location.reload();
        }}
      />

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
    </Box>
  );
};

function formatSaveTime(date) {
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}

export default NoteEditor;
