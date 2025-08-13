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
  LinearProgress
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
  CloudUpload as UploadIcon
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

const NoteEditor = ({ note, onUpdateNote, onBack, isMobile = false }) => {
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
  
  // Track current note and initial values
  const currentNoteId = useRef(null);
  const initialValues = useRef({ title: '', content: '' });
  const saveTimeoutRef = useRef(null);
  const lockTimeoutRef = useRef(null);
  const lockExtensionIntervalRef = useRef(null);
  const editorReadyRef = useRef(false);
  const userInteractedRef = useRef(false);
  const fileInputRef = useRef(null);
  const dragCounterRef = useRef(0);

  // Tiptap editor configuration with image support
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
      if (!isInitializing && editorReadyRef.current) {
        userInteractedRef.current = true;
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
      handleDrop: (view, event, slice, moved) => {
        // We'll define handleMultipleFiles later, so we'll handle this in the effect
        if (event.dataTransfer && event.dataTransfer.files.length > 0) {
          const files = Array.from(event.dataTransfer.files);
          const imageFiles = files.filter(file => file.type.startsWith('image/'));
          
          if (imageFiles.length > 0) {
            event.preventDefault();
            // This will be handled by the effect
            return true;
          }
        }
        return false;
      },
      handlePaste: (view, event, slice) => {
        // This will be handled by the effect
        return false;
      },
    },
  });

  // Get current editor content - MOVED BEFORE OTHER CALLBACKS
  const getCurrentContent = useCallback(() => {
    if (!editor) return '';
    return editor.getHTML();
  }, [editor]);

  // Basic event handlers - MOVED BEFORE OTHER CALLBACKS
  const handleUserInteraction = useCallback(() => {
    if (!isInitializing && editorReadyRef.current) {
      userInteractedRef.current = true;
    }
  }, [isInitializing]);

  const handleTitleChange = useCallback((e) => {
    setTitle(e.target.value);
    handleUserInteraction();
  }, [handleUserInteraction]);

  const handleTitleFocus = useCallback((e) => {
    if (title === 'Untitled') {
      setTitle('');
      handleUserInteraction();
    }
  }, [title, handleUserInteraction]);

  // Change detection - NOW AFTER getCurrentContent IS DEFINED
  const checkForChanges = useCallback(() => {
    if (!note || !editorReadyRef.current || isInitializing || !userInteractedRef.current || !editor) {
      return false;
    }

    const currentTitle = title || '';
    const initialTitle = initialValues.current.title || '';
    const titleChanged = currentTitle !== initialTitle;
    
    const currentContent = getCurrentContent();
    const initialContent = initialValues.current.content || '';
    const contentChanged = currentContent !== initialContent;
    
    return titleChanged || contentChanged;
  }, [note, title, isInitializing, getCurrentContent, editor]);

  // Save function - NOW AFTER getCurrentContent IS DEFINED
  const saveNote = useCallback(async (noteId, updates) => {
    if (!noteId) return;
    
    setSaving(true);
    try {
      await onUpdateNote(noteId, updates);
      setLastSaved(new Date());
      setHasUnsavedChanges(false);
      
      // Update initial values with the current content
      initialValues.current = { 
        title: updates.title !== undefined ? updates.title : title,
        content: updates.content !== undefined ? updates.content : getCurrentContent()
      };
      
      console.log('Save successful, updated initial values');
      
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

  // Manual save for navigation - NOW AFTER saveNote IS DEFINED
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

  // Image upload function
  const uploadImage = useCallback(async (file) => {
    if (!note?.id) {
      throw new Error('No note selected');
    }

    // Validate file
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('Image must be smaller than 10MB');
    }

    if (!file.type.startsWith('image/')) {
      throw new Error('File must be an image');
    }

    // If offline, store image locally
    if (!navigator.onLine) {
      return await storeImageOffline(file);
    }

    // Upload to server
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
        // Network error - store offline
        return await storeImageOffline(file);
      } else {
        throw new Error('Failed to upload image. Please try again.');
      }
    }
  }, [note?.id]);

  // Store image offline for later sync
  const storeImageOffline = useCallback(async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const tempId = `temp_img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const imageData = {
          id: tempId,
          url: reader.result, // base64 data URL
          offline: true,
          file: {
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified
          },
          fileData: reader.result, // Store the actual file data
          noteId: note?.id,
          createdAt: new Date().toISOString()
        };

        // Store in localStorage for later upload
        try {
          const offlineImages = JSON.parse(localStorage.getItem('offlineImages') || '[]');
          offlineImages.push(imageData);
          localStorage.setItem('offlineImages', JSON.stringify(offlineImages));
          
          console.log('Stored image offline:', tempId);
          
          resolve({
            url: reader.result,
            width: null, // We'll get this when uploaded
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

  // Sync offline images when back online
  const syncOfflineImages = useCallback(async () => {
    if (!note?.id) return;
    
    try {
      const offlineImages = JSON.parse(localStorage.getItem('offlineImages') || '[]');
      const noteImages = offlineImages.filter(img => img.noteId === note.id);

      if (noteImages.length === 0) return;

      console.log(`Syncing ${noteImages.length} offline images for note ${note.id}`);

      for (const imageData of noteImages) {
        try {
          // Convert base64 back to file
          const response = await fetch(imageData.fileData);
          const blob = await response.blob();
          const file = new File([blob], imageData.file.name, { 
            type: imageData.file.type,
            lastModified: imageData.file.lastModified 
          });

          // Upload to server
          const uploadResult = await uploadImage(file);
          
          if (!uploadResult.offline) {
            // Update the image in the editor content
            const content = editor?.getHTML();
            if (content && content.includes(imageData.url)) {
              const updatedContent = content.replace(
                new RegExp(imageData.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
                uploadResult.url
              );
              editor?.commands.setContent(updatedContent);
              
              // Trigger a save to persist the updated URLs
              userInteractedRef.current = true;
            }

            // Remove from offline storage
            const updatedOfflineImages = offlineImages.filter(img => img.id !== imageData.id);
            localStorage.setItem('offlineImages', JSON.stringify(updatedOfflineImages));
            
            console.log(`Successfully synced offline image ${imageData.id} -> ${uploadResult.id}`);
          }
        } catch (error) {
          console.error('Failed to sync offline image:', imageData.id, error);
        }
      }
    } catch (error) {
      console.error('Failed to sync offline images:', error);
    }
  }, [note?.id, uploadImage, editor]);

  // Handle file selection and upload
  const handleImageUpload = useCallback(async (file) => {
    if (!file) return;

    setImageUploading(true);
    setImageError('');
    setUploadProgress(0);

    try {
      const result = await uploadImage(file);
      
      // Insert image into editor at current position
      editor?.chain().focus().setImage({
        src: result.url,
        alt: file.name,
        title: file.name,
        'data-image-id': result.id
      }).run();

      setImageUploadDialog(false);
      
      // Show success message for offline uploads
      if (result.offline) {
        setImageError('');
        // Could show a toast here about offline storage
      }
      
    } catch (error) {
      setImageError(error.message);
    } finally {
      setImageUploading(false);
      setUploadProgress(0);
    }
  }, [uploadImage, editor]);

  // Handle multiple file uploads
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
      // Small delay between uploads
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }, [handleImageUpload]);

  // Drag and drop handlers
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

  // Paste handler
  const handlePaste = useCallback((e) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    
    if (imageItems.length > 0) {
      e.preventDefault();
      
      imageItems.forEach(item => {
        const file = item.getAsFile();
        if (file) {
          handleImageUpload(file);
        }
      });
    }
  }, [handleImageUpload]);

  // File input handler
  const handleFileInputChange = useCallback((event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      handleMultipleFiles(files);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [handleMultipleFiles]);

  // Navigation handlers
  const handleBack = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    
    await handleManualSave();
    if (onBack) {
      onBack();
    }
  }, [handleManualSave, onBack]);

  // Toolbar handlers
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

  // Lock management (keeping the same as before)
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

  // Effects

  // Reset state when note changes
  useEffect(() => {
    if (note && note.id !== currentNoteId.current) {
      console.log('Loading new note:', note.id);
      
      if (currentNoteId.current) {
        releaseLock(currentNoteId.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      
      setIsInitializing(true);
      editorReadyRef.current = false;
      userInteractedRef.current = false;
      
      const newTitle = note.title || '';
      const newContent = note.content || '';
      
      currentNoteId.current = note.id;
      initialValues.current = { title: newTitle, content: newContent };
      
      setTitle(newTitle);
      setLastSaved(new Date(note.updatedAt));
      setHasUnsavedChanges(false);
      setIsLocked(false);
      setLockError('');
      
      if (note.locked && note.lockedBy) {
        setLockOwner(note.lockedBy);
        setLockError(`Note is being edited by another user`);
      } else {
        setLockOwner(null);
      }
      
      // Set editor content after a brief delay to ensure editor is ready
      if (editor) {
        setTimeout(() => {
          editor.commands.setContent(newContent || '');
          
          setTimeout(() => {
            setIsInitializing(false);
            editorReadyRef.current = true;
            
            // Sync offline images when note loads (if online)
            if (navigator.onLine) {
              syncOfflineImages();
            }
            
            // Final baseline setup
            setTimeout(() => {
              if (currentNoteId.current === note.id) {
                initialValues.current = { 
                  title: newTitle, 
                  content: newContent
                };
                console.log('Note initialization complete with image support');
              }
            }, 200);
          }, 100);
        }, 100);
      }
      
    } else if (!note) {
      if (currentNoteId.current) {
        releaseLock(currentNoteId.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      
      setTitle('');
      if (editor) {
        editor.commands.setContent('');
      }
      setLastSaved(null);
      setHasUnsavedChanges(false);
      setIsLocked(false);
      setLockError('');
      setLockOwner(null);
      setIsInitializing(false);
      initialValues.current = { title: '', content: '' };
      currentNoteId.current = null;
      editorReadyRef.current = false;
      userInteractedRef.current = false;
    }
  }, [note, releaseLock, editor, syncOfflineImages]);

  // Watch for editor content changes
  useEffect(() => {
    if (isInitializing || !editorReadyRef.current || !userInteractedRef.current || !editor) {
      return;
    }
    
    if (note && currentNoteId.current === note.id) {
      const hasChanges = checkForChanges();
      
      if (hasChanges) {
        console.log('Real changes detected by user interaction');
      }
      
      setHasUnsavedChanges(hasChanges);
      
      if (hasChanges) {
        if (!isLocked && !lockOwner && note.permission === 'edit') {
          acquireLock(note.id);
        }
        
        if (isLocked || !lockOwner) {
          if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
          }
          
          saveTimeoutRef.current = setTimeout(() => {
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
              console.log('Auto-saving real changes:', updates);
              saveNote(note.id, updates);
            }
            saveTimeoutRef.current = null;
          }, 2000);
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

  // Update editor props to use the properly defined handlers
  useEffect(() => {
    if (editor) {
      editor.setOptions({
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
          handleDrop: (view, event, slice, moved) => {
            if (event.dataTransfer && event.dataTransfer.files.length > 0) {
              const files = Array.from(event.dataTransfer.files);
              const imageFiles = files.filter(file => file.type.startsWith('image/'));
              
              if (imageFiles.length > 0) {
                event.preventDefault();
                handleMultipleFiles(imageFiles);
                return true;
              }
            }
            return false;
          },
          handlePaste: (view, event, slice) => {
            handlePaste(event);
            return false;
          },
        },
      });
    }
  }, [editor, isMobile, handleMultipleFiles, handlePaste]);

  // Sync offline images when coming back online
  useEffect(() => {
    const handleOnline = () => {
      if (note?.id) {
        console.log('Coming back online, syncing images...');
        syncOfflineImages();
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [note?.id, syncOfflineImages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (currentNoteId.current) {
        releaseLock(currentNoteId.current);
      }
      if (lockExtensionIntervalRef.current) {
        clearInterval(lockExtensionIntervalRef.current);
      }
    };
  }, [releaseLock]);

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
  const isShared = note.shared || false;

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
                  <Tooltip title={note.sharedBy ? `Shared by ${note.sharedBy}` : 'Shared note'}>
                    <Chip
                      icon={<PeopleIcon />}
                      label="Shared"
                      size="small"
                      color="secondary"
                    />
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

      <ShareNoteDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        note={note}
        onNoteUpdated={() => {
          window.location.reload();
        }}
      />
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