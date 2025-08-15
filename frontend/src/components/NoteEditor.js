import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  Refresh as RefreshIcon
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

const NoteEditor = ({ 
  note, 
  onUpdateNote, 
  onBack, 
  isMobile = false, 
  currentUser,
  notes = [],                    // NEW: Array of all notes for bulk sync
  onNotesUpdated               // NEW: Callback when bulk sync updates notes
}) => {
  // ===== STATE DECLARATIONS =====
  const [title, setTitle] = useState('');
  const [lastSaved, setLastSaved] = useState(null);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [lockOwner, setLockOwner] = useState(null);
  const [lockError, setLockError] = useState('');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  
  // Image upload states
  const [imageUploadDialog, setImageUploadDialog] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  
  // Enhanced collaboration state
  const [activeEditors, setActiveEditors] = useState([]);
  const [hasRemoteChanges, setHasRemoteChanges] = useState(false);
  const [lastUpdateTimestamp, setLastUpdateTimestamp] = useState(null);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [pendingRemoteUpdate, setPendingRemoteUpdate] = useState(null);
  const [showCollaborationAlert, setShowCollaborationAlert] = useState(true);
  const [syncingChanges, setSyncingChanges] = useState(false);
  
  // NEW: Bulk sync states
  const [bulkSyncInProgress, setBulkSyncInProgress] = useState(false);
  const [lastBulkSync, setLastBulkSync] = useState(null);
  const [bulkSyncResults, setBulkSyncResults] = useState(null);
  const [appResumeSync, setAppResumeSync] = useState(false);

  // ===== REF DECLARATIONS =====
  const currentNoteId = useRef(null);
  const initialValues = useRef({ title: '', content: '' });
  const saveTimeoutRef = useRef(null);
  const lockTimeoutRef = useRef(null);
  const lockExtensionIntervalRef = useRef(null);
  const editorReadyRef = useRef(false);
  const userInteractedRef = useRef(false);
  const fileInputRef = useRef(null);
  const dragCounterRef = useRef(0);
  const pollIntervalRef = useRef(null);
  const presenceIntervalRef = useRef(null);
  const lastLocalUpdateRef = useRef(null);
  const collaborationActiveRef = useRef(false);
  const sharedNotePollIntervalRef = useRef(null);
  const noteTimestampRef = useRef(null);
  const applyingRemoteChangesRef = useRef(false);
  
  // NEW: Bulk sync refs
  const bulkSyncTimeoutRef = useRef(null);
  const lastBulkSyncTimeRef = useRef(null);

  // ===== APP LIFECYCLE INTEGRATION =====
  const handleAppResume = useCallback(async () => {
    console.log('📱 App resumed - triggering sync check');
    
    // IMMEDIATE: Always check current note for updates when app resumes
    if (note?.id && (note.shared || note.hasBeenShared)) {
      console.log('⚡ Checking current shared note for updates immediately');
      setTimeout(() => {
        // Call checkForUpdates inline to avoid dependency issues
        if (typeof checkForUpdates === 'function') {
          checkForUpdates();
        }
      }, 500);
    }
    
    if (!currentUser || !notes || notes.length === 0) {
      console.log('⭐ Skipping bulk sync - no user or notes');
      return;
    }
    
    setAppResumeSync(true);
    setBulkSyncInProgress(true);
    
    try {
      console.log(`🔄 Starting bulk sync for ${notes.length} notes after app resume`);
      const results = await syncService.syncAllNotes(notes, currentUser);
      
      console.log('✅ Bulk sync complete:', {
        updated: results.updatedNotes.length,
        conflicts: results.conflicts.length,
        errors: results.errors.length
      });
      
      setBulkSyncResults(results);
      setLastBulkSync(new Date());
      lastBulkSyncTimeRef.current = Date.now();
      
      // Notify parent component of updates
      if (results.updatedNotes.length > 0 && onNotesUpdated) {
        console.log('📥 Notifying App.js of bulk sync updates');
        onNotesUpdated(results.updatedNotes);
      }
      
      // Handle conflicts if any
      if (results.conflicts.length > 0) {
        console.log('⚠️ Conflicts detected during bulk sync:', results.conflicts.length);
        // For now, just log - could show a conflict summary dialog
        results.conflicts.forEach(conflict => {
          console.log('⚠️ Conflict in note:', conflict.note.id, conflict.note.title);
        });
      }
      
      // Clear results after a delay
      setTimeout(() => {
        setBulkSyncResults(null);
      }, 5000);
      
    } catch (error) {
      console.error('❌ Bulk sync failed:', error);
    } finally {
      setBulkSyncInProgress(false);
      setAppResumeSync(false);
    }
  }, [currentUser, notes, onNotesUpdated, note?.id, note?.shared, note?.hasBeenShared]);

  const handleAppBackground = useCallback(() => {
    console.log('📱 App backgrounded - stopping high-frequency polling');
    stopActiveCollaborationPolling();
  }, []);

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
    onUpdate: ({ editor }) => {
      if (!isInitializing && editorReadyRef.current && !applyingRemoteChangesRef.current) {
        console.log('👤 User interaction detected (not remote update)');
        userInteractedRef.current = true;
        
        // NEW: Mark note as having pending changes in sync service
        if (note?.id) {
          syncService.markNotePending(note.id);
        }
      } else if (applyingRemoteChangesRef.current) {
        console.log('🔄 Ignoring programmatic content update (remote changes)');
      }
    },
    editorProps: {
      attributes: {
        style: `
          padding: ${isMobile ? '12px' : '16px'}; 
          font-size: 18px; 
          line-height: 1.6; 
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

  // ===== UTILITY FUNCTIONS =====
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
      
      // NEW: Mark note as having pending changes
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
  }, [handleUserInteraction, title, isInitializing]);

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
    
    // NEW: Enhanced false conflict detection in checkForChanges too
    const isLikelyTitleTimingIssue = !currentTitle && initialTitle && 
                                   (initialTitle === 'offline test' || initialTitle.length > 0);
    const isEmptyTitleButShouldBe = !currentTitle && initialTitle;
    
    // Don't count title changes if it's likely a timing issue
    const realTitleChanged = titleChanged && !isLikelyTitleTimingIssue && !isEmptyTitleButShouldBe;
    
    const hasChanges = realTitleChanged || contentChanged;
    
    if (hasChanges) {
      console.log('📝 Local changes detected:', {
        titleChanged: realTitleChanged,
        contentChanged,
        isLikelyTitleTimingIssue,
        isEmptyTitleButShouldBe,
        currentTitle: currentTitle.substring(0, 30) + (currentTitle.length > 30 ? '...' : ''),
        initialTitle: initialTitle.substring(0, 30) + (initialTitle.length > 30 ? '...' : ''),
        currentContentLength: currentContent?.length || 0,
        initialContentLength: initialContent?.length || 0,
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

  // ===== ENHANCED COLLABORATION FUNCTIONS =====
  const stopActiveCollaborationPolling = useCallback(() => {
    if (!collaborationActiveRef.current) {
      console.log('ℹ️ High-frequency polling not active, nothing to stop');
      return;
    }
    
    collaborationActiveRef.current = false;
    console.log('🛑 Stopping high-frequency collaboration polling');
    
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
      console.log('✅ High-frequency polling stopped');
    }
  }, []);

  const stopSharedNotePolling = useCallback(() => {
    if (sharedNotePollIntervalRef.current) {
      console.log('🛑 Stopping background polling for shared note');
      clearInterval(sharedNotePollIntervalRef.current);
      sharedNotePollIntervalRef.current = null;
      console.log('✅ Background polling stopped');
    } else {
      console.log('ℹ️ No background polling to stop');
    }
  }, []);

  const registerPresence = useCallback(async (action = 'join') => {
    if (!note?.id || !currentUser) {
      console.log('❌ Cannot register presence:', {
        hasNoteId: !!note?.id,
        hasCurrentUser: !!currentUser,
        action
      });
      return;
    }
    
    try {
      console.log('👋 Registering presence:', {
        action,
        noteId: note.id,
        userId: currentUser.id,
        userName: currentUser.name
      });
      
      await api.post(`/api/notes/${note.id}/presence`, {
        action,
        editorInfo: {
          name: currentUser?.name || 'Anonymous',
          avatar: currentUser?.avatar,
          id: currentUser?.id
        }
      });
      console.log(`✅ Presence ${action} successful for note ${note.id}`);
    } catch (error) {
      if (error.response?.status === 500) {
        console.log('⚠️ Presence endpoint not available (500) - continuing without presence tracking');
        // Don't spam errors for unimplemented endpoint
      } else {
        console.error('❌ Failed to register presence:', error);
      }
    }
  }, [note?.id, currentUser]);

  const startActiveCollaborationPolling = useCallback(() => {
    if (collaborationActiveRef.current) {
      console.log('⭐ High-frequency polling already active, skipping');
      return;
    }
    
    collaborationActiveRef.current = true;
    console.log('🚀 Starting high-frequency collaboration polling (every 5 seconds)');
    
    pollIntervalRef.current = setInterval(() => {
      console.log('⏰ High-frequency polling interval triggered');
      checkForUpdates();
    }, 5000);
    
  }, []);

  // NEW: Enhanced applyRemoteChanges with conflict resolution
  const applyRemoteChanges = useCallback(({ content, title: remoteTitle, updatedAt, strategy = 'replace' }) => {
    console.log('📝 Applying remote changes with strategy:', strategy, {
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
        console.log('🔄 Applied intelligent merge strategy');
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
        editor?.commands.setContent(finalContent);
      }
      
      if (finalTitle && finalTitle !== title) {
        console.log('📝 Updating title:', finalTitle);
        setTitle(finalTitle);
      }
      
      noteTimestampRef.current = updatedAt;
      setLastUpdateTimestamp(updatedAt);
      setLastSaved(new Date(updatedAt));
      setHasRemoteChanges(true);
      
      // NEW: Clear pending status since we've synced
      if (note?.id) {
        syncService.clearNotePending(note.id);
      }
      
      setTimeout(() => setHasRemoteChanges(false), 3000);
      
    } finally {
      // Longer delay to ensure React state updates complete
      setTimeout(() => {
        applyingRemoteChangesRef.current = false;
        console.log('🔄 Remote changes application complete');
      }, 200); // Increased from 100ms to 200ms
    }
    
  }, [editor, getCurrentContent, title, note?.id]);

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
      
      // NEW: Clear pending status after successful save
      syncService.clearNotePending(noteId);
      
      console.log('💾 Save successful, updated initial values');
      
      // NEW: Update initial values after save to prevent false conflict detection
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
      
      if (hasLocalChanges && !applyingRemoteChangesRef.current) {
        console.log('⚠️ Conflict detected - showing resolution dialog');
        setPendingRemoteUpdate({ content, title: remoteTitle, updatedAt, lastEditor });
        setConflictDialogOpen(true);
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
      
      const otherEditors = editors.filter(editor => editor.id !== currentUser?.id);
      setActiveEditors(otherEditors);
      
      const wasActive = collaborationActiveRef.current;
      const shouldBeActive = otherEditors.length > 0;
      
      if (shouldBeActive && !wasActive) {
        console.log(`🚀 ${otherEditors.length} other editors detected, starting high-frequency polling`);
        startActiveCollaborationPolling();
      } else if (!shouldBeActive && wasActive) {
        console.log('🛑 No other editors detected, reducing to background polling');
        stopActiveCollaborationPolling();
      }
      
    } catch (error) {
      if (error.response?.status === 500) {
        console.log('⚠️ Presence endpoint not available (500) - continuing without presence detection');
        // Don't spam errors for unimplemented endpoint
      } else if (error.response?.status !== 429) {
        console.error('❌ Failed to check active editors:', error);
      }
    }
  }, [note?.id, currentUser?.id, startActiveCollaborationPolling, stopActiveCollaborationPolling]);

  // NEW: Manual bulk sync trigger
  const handleManualBulkSync = useCallback(async () => {
    if (bulkSyncInProgress || !currentUser || !notes || notes.length === 0) {
      return;
    }
    
    setBulkSyncInProgress(true);
    console.log('🔄 Manual bulk sync triggered');
    
    try {
      const results = await syncService.syncAllNotes(notes, currentUser);
      setBulkSyncResults(results);
      setLastBulkSync(new Date());
      
      if (results.updatedNotes.length > 0 && onNotesUpdated) {
        onNotesUpdated(results.updatedNotes);
      }
      
      setTimeout(() => setBulkSyncResults(null), 5000);
      
    } catch (error) {
      console.error('❌ Manual bulk sync failed:', error);
    } finally {
      setBulkSyncInProgress(false);
    }
  }, [bulkSyncInProgress, currentUser, notes, onNotesUpdated]);

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
    if (currentContent !== initialContent) {
      updates.content = currentContent;
    }
    
    if (Object.keys(updates).length > 0) {
      console.log('Manual save triggered with changes:', updates);
      await saveNote(note.id, updates);
    }
  }, [note, title, getCurrentContent, saveNote, editor]);

  // NEW: Enhanced conflict resolution with strategies
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
      editor?.commands.setContent(finalContent);
      setLastUpdateTimestamp(updatedAt);
      
      setTimeout(() => {
        saveNote(note.id, { title: finalTitle, content: finalContent });
      }, 500);
      
    } else if (resolution === 'smart-merge') {
      console.log('🧠 Smart merging changes');
      // NEW: Use smart merge for lists
      const currentContent = getCurrentContent();
      const finalContent = ConflictResolutionStrategies.smartMergeList(currentContent, remoteContent);
      
      editor?.commands.setContent(finalContent);
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
    
    // NEW: Clear pending status when leaving note
    if (note?.id) {
      syncService.clearNotePending(note.id);
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

  const acquireLock = useCallback(async (noteId) => {
    if (!noteId) return false;
    
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
        }
        setIsLocked(false);
        return false;
      }
      
      setIsLocked(true);
      setLockError('');
      
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
          
          if (!extendResponse.ok && (extendResponse.status === 409 || extendResponse.status === 423)) {
            console.error('Lock conflict during extension');
            setLockError('Another user is now editing this note');
            setIsLocked(false);
            clearInterval(lockExtensionIntervalRef.current);
          }
        } catch (error) {
          console.warn('Lock extension failed:', error.message);
        }
      }, 15000);
      
      return true;
    } catch (error) {
      console.error('Lock acquisition failed:', error);
      setIsLocked(false);
      return false;
    }
  }, []);

  const startSharedNotePolling = useCallback(() => {
    if ((!note?.shared && !note?.hasBeenShared) || sharedNotePollIntervalRef.current) {
      return;
    }
    
    console.log('🔄 Starting background polling for shared note');
    
    // Reduced from 45 seconds to 15 seconds for faster sync
    sharedNotePollIntervalRef.current = setInterval(() => {
      console.log('⏰ Background polling interval triggered for shared note');
      checkForUpdates();
      
      setTimeout(() => {
        checkActiveEditors();
      }, 2000);
    }, 15000); // Changed from 45000 to 15000 for faster sync
    
  }, [note?.shared, note?.hasBeenShared, checkForUpdates, checkActiveEditors]);

  // ===== EFFECTS =====
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
        registerPresence('leave');
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
      stopActiveCollaborationPolling();
      stopSharedNotePolling();
      
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
      
      setLastUpdateTimestamp(timestamp);
      
      if (note.locked && note.lockedBy) {
        setLockOwner(note.lockedBy);
        setLockError(`Note is being edited by another user`);
      } else {
        setLockOwner(null);
      }
      
      // Set editor content after a brief delay
      if (editor) {
        setTimeout(() => {
          editor.commands.setContent(newContent || '');
          
          setTimeout(() => {
            setIsInitializing(false);
            editorReadyRef.current = true;
            
            setTimeout(() => {
              if (currentNoteId.current === note.id) {
                initialValues.current = { 
                  title: newTitle, 
                  content: newContent
                };
                
                // Initialize collaboration after state is stable
                setTimeout(() => {
                  if (currentUser) {
                    console.log('🤝 Initializing collaboration for note:', note.id);
                    registerPresence('join');
                    checkActiveEditors();
                    
                    const isCollaborativeNote = note.shared || note.hasBeenShared;
                    
                    if (isCollaborativeNote) {
                      startSharedNotePolling();
                      
                      // NEW: Immediate sync check for shared notes to get latest content
                      console.log('⚡ Triggering immediate sync for shared note');
                      setTimeout(() => {
                        checkForUpdates();
                      }, 1000); // Check for updates 1 second after loading
                    }
                  }
                }, 200);
              }
            }, 200);
          }, 100);
        }, 100);
      }
      
    } else if (!note) {
      console.log('🗑️ No note selected, cleaning up');
      // Cleanup when no note
      if (currentNoteId.current) {
        releaseLock(currentNoteId.current);
        registerPresence('leave');
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
      stopActiveCollaborationPolling();
      stopSharedNotePolling();
      
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
      initialValues.current = { title: '', content: '' };
      currentNoteId.current = null;
      editorReadyRef.current = false;
      userInteractedRef.current = false;
    }
  }, [
    note, 
    releaseLock, 
    editor, 
    registerPresence, 
    checkActiveEditors, 
    stopActiveCollaborationPolling, 
    stopSharedNotePolling, 
    startSharedNotePolling, 
    currentUser
  ]);

  // Enhanced presence checking for shared notes
  useEffect(() => {
    if (note?.id && currentUser) {
      const isCollaborativeNote = note.shared || note.hasBeenShared;
      // Increased interval to reduce 500 errors, and different timing for collaborative vs non-collaborative
      const checkInterval = isCollaborativeNote ? 60000 : 120000; // 1-2 minutes instead of 20-60 seconds
      
      presenceIntervalRef.current = setInterval(async () => {
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
  }, [note?.id, note?.shared, note?.hasBeenShared, currentUser, checkActiveEditors]);

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

  // NEW: Bulk sync periodic trigger for collaborative notes
  useEffect(() => {
    if (!note?.id || (!note.shared && !note.hasBeenShared) || !currentUser) {
      return;
    }
    
    // Trigger periodic bulk sync for shared notes - reduced interval for faster sync
    const bulkSyncInterval = setInterval(() => {
      const timeSinceLastBulkSync = lastBulkSyncTimeRef.current 
        ? Date.now() - lastBulkSyncTimeRef.current 
        : Infinity;
      
      // Reduced from 2 minutes to 30 seconds for faster collaboration
      if (timeSinceLastBulkSync > 30000 && !bulkSyncInProgress) {
        console.log('⏰ Periodic bulk sync triggered for collaborative note');
        handleManualBulkSync();
      }
    }, 20000); // Check every 20 seconds instead of 60 seconds
    
    return () => clearInterval(bulkSyncInterval);
  }, [note?.id, note?.shared, note?.hasBeenShared, currentUser, bulkSyncInProgress, handleManualBulkSync]);

  // Enhanced cleanup on unmount
  useEffect(() => {
    return () => {
      if (currentNoteId.current) {
        releaseLock(currentNoteId.current);
        registerPresence('leave');
        syncService.clearNotePending(currentNoteId.current);
      }
      if (lockExtensionIntervalRef.current) {
        clearInterval(lockExtensionIntervalRef.current);
      }
      if (presenceIntervalRef.current) {
        clearInterval(presenceIntervalRef.current);
      }
      if (bulkSyncTimeoutRef.current) {
        clearTimeout(bulkSyncTimeoutRef.current);
      }
      stopActiveCollaborationPolling();
      stopSharedNotePolling();
    };
  }, [releaseLock, registerPresence, stopActiveCollaborationPolling, stopSharedNotePolling]);

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
              {/* NEW: Bulk sync indicator */}
              {bulkSyncInProgress && (
                <Tooltip title="Syncing all notes">
                  <RefreshIcon color="info" fontSize="small" className="rotating" />
                </Tooltip>
              )}
              
              {syncingChanges && <SyncIcon color="primary" fontSize="small" className="rotating" />}
              {saving && <SaveIcon color="primary" fontSize="small" />}
              {hasUnsavedChanges && !saving && (
                <Chip label="•" size="small" color="warning" sx={{ minWidth: 8, height: 8, '& .MuiChip-label': { px: 0 } }} />
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
              
              {/* NEW: Manual bulk sync button for mobile */}
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
          {lockError && (
            <Alert severity="warning" sx={{ mb: 2 }} icon={<WarningIcon />}>
              {lockError}
            </Alert>
          )}

          {/* NEW: Bulk sync status alert */}
          {(bulkSyncInProgress || appResumeSync) && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {appResumeSync 
                ? 'Checking for updates after app resume...'
                : 'Syncing all notes for recent changes...'
              }
            </Alert>
          )}
          
          {/* NEW: Bulk sync results alert */}
          {bulkSyncResults && (
            <Alert 
              severity={bulkSyncResults.conflicts.length > 0 ? "warning" : "success"} 
              sx={{ mb: 2 }}
            >
              {bulkSyncResults.updatedNotes.length > 0 && 
                `${bulkSyncResults.updatedNotes.length} notes updated. `
              }
              {bulkSyncResults.conflicts.length > 0 && 
                `${bulkSyncResults.conflicts.length} conflicts detected. `
              }
              {bulkSyncResults.errors.length > 0 && 
                `${bulkSyncResults.errors.length} sync errors. `
              }
              {lastBulkSync && `Last sync: ${formatSaveTime(lastBulkSync)}`}
            </Alert>
          )}

          {/* Enhanced Collaboration Alert */}
          {activeEditors.length > 0 && showCollaborationAlert && (
            <Collapse in={showCollaborationAlert}>
              <Alert 
                severity="info" 
                sx={{ mb: 2 }}
                action={
                  <IconButton
                    aria-label="close"
                    color="inherit"
                    size="small"
                    onClick={() => setShowCollaborationAlert(false)}
                  >
                    <ExpandLessIcon />
                  </IconButton>
                }
                icon={
                  <AvatarGroup max={3} sx={{ '& .MuiAvatar-root': { width: 24, height: 24 } }}>
                    {activeEditors.slice(0, 3).map(editor => (
                      <Avatar key={editor.id} src={editor.avatar} sx={{ width: 24, height: 24 }}>
                        {editor.name?.charAt(0)}
                      </Avatar>
                    ))}
                  </AvatarGroup>
                }
              >
                {activeEditors.length === 1 
                  ? `${activeEditors[0].name} is also editing this note`
                  : `${activeEditors.length} others are editing this note`
                }
                {collaborationActiveRef.current && (
                  <Typography variant="caption" display="block" sx={{ mt: 0.5, opacity: 0.8 }}>
                    Real-time sync active
                  </Typography>
                )}
              </Alert>
            </Collapse>
          )}
          
          {hasRemoteChanges && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Note updated with recent changes from collaborators
            </Alert>
          )}

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
                {/* NEW: Bulk sync indicator */}
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
                
                {/* NEW: Manual bulk sync button */}
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
              {/* Toolbar */}
              {canEdit && (
                <Box sx={{ 
                  borderBottom: 1, 
                  borderColor: 'divider',
                  p: 1,
                  display: 'flex',
                  gap: 0.5,
                  flexWrap: 'wrap',
                  alignItems: 'center'
                }}>
                  <ButtonGroup size="small" variant="outlined">
                    <IconButton
                      size="small"
                      onClick={handleUndo}
                      disabled={!editor?.can().undo()}
                      title="Undo"
                    >
                      <UndoIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={handleRedo}
                      disabled={!editor?.can().redo()}
                      title="Redo"
                    >
                      <RedoIcon fontSize="small" />
                    </IconButton>
                  </ButtonGroup>
                  
                  <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                  
                  <ButtonGroup size="small" variant="outlined">
                    <IconButton
                      size="small"
                      onClick={handleBold}
                      color={editor?.isActive('bold') ? 'primary' : 'default'}
                      title="Bold"
                    >
                      <BoldIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleItalic}
                      color={editor?.isActive('italic') ? 'primary' : 'default'}
                      title="Italic"
                    >
                      <ItalicIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleUnderline}
                      color={editor?.isActive('underline') ? 'primary' : 'default'}
                      title="Underline"
                    >
                      <UnderlineIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleStrikethrough}
                      color={editor?.isActive('strike') ? 'primary' : 'default'}
                      title="Strikethrough"
                    >
                      <StrikethroughIcon fontSize="small" />
                    </IconButton>
                  </ButtonGroup>
                  
                  <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                  
                  <ButtonGroup size="small" variant="outlined">
                    <IconButton
                      size="small"
                      onClick={handleBulletList}
                      color={editor?.isActive('bulletList') ? 'primary' : 'default'}
                      title="Bullet List"
                    >
                      <BulletIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleOrderedList}
                      color={editor?.isActive('orderedList') ? 'primary' : 'default'}
                      title="Numbered List"
                    >
                      <NumberIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleTaskList}
                      color={editor?.isActive('taskList') ? 'primary' : 'default'}
                      title="Task List (Checkboxes)"
                    >
                      <CheckboxIcon fontSize="small" />
                    </IconButton>
                  </ButtonGroup>
                  
                  <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                  
                  <ButtonGroup size="small" variant="outlined">
                    <IconButton
                      size="small"
                      onClick={handleBlockquote}
                      color={editor?.isActive('blockquote') ? 'primary' : 'default'}
                      title="Quote"
                    >
                      <QuoteIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleCodeBlock}
                      color={editor?.isActive('codeBlock') ? 'primary' : 'default'}
                      title="Code Block"
                    >
                      <CodeIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleLink}
                      color={editor?.isActive('link') ? 'primary' : 'default'}
                      title="Link"
                    >
                      <LinkIcon fontSize="small" />
                    </IconButton>
                    
                    <IconButton
                      size="small"
                      onClick={handleImageButton}
                      title="Insert Image"
                    >
                      <ImageIcon fontSize="small" />
                    </IconButton>
                  </ButtonGroup>
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
                  '& h6': { fontSize: '1rem', fontWeight: 600, margin: '1rem 0 0.5rem' },
                  '& p': { margin: '0.5rem 0' },
                  '& ul, & ol': { margin: '0.5rem 0', paddingLeft: '1.5rem' },
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
                        marginTop: '0.2rem',
                        userSelect: 'none',
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