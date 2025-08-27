// src/services/syncService.js - Complete file
import api from '../utils/api';
import offlineStorage from '../utils/offlineStorage';

class SyncService {
  constructor() {
    this.lastGlobalSync = null;
    this.syncInProgress = false;
    this.pendingNotes = new Set();
  }
  
  // Normalize content to prevent hash differences from whitespace/formatting
  normalizeContent(content) {
    if (!content) return '';
    return content
      .replace(/\r\n/g, '\n')                    // Normalize line endings (Windows)
      .replace(/\r/g, '\n')                     // Handle old Mac line endings  
      .replace(/\s+$/gm, '')                    // Remove trailing whitespace from each line
      .replace(/(<p><\/p>)+/g, '')              // Remove empty paragraphs anywhere (not just end)
      .replace(/(<p><br><\/p>)+/g, '')          // Remove paragraphs containing only <br>
      .replace(/(<p>\s*<\/p>)+/g, '')           // Remove paragraphs with only whitespace
      .replace(/>\s+</g, '><')                  // Remove whitespace between tags
      .replace(/\s+/g, ' ')                     // Normalize multiple spaces to single space
      .trim();                                  // Remove leading/trailing whitespace
  }

  // Generate content hash for change detection (client-side)
  async generateContentHash(title, content) {
    // CRITICAL: Normalize content before hashing to match server behavior
    const normalizedContent = this.normalizeContent(content || '');
    const normalizedTitle = (title || '').trim();
    const combined = `${normalizedTitle}|||${normalizedContent}`;
    
    // Use Web Crypto API with SHA-256 (MD5 not supported in browsers)
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, 8);
  }

  // NEW: Intelligent bulk sync using metadata pre-filtering
  async syncAllNotes(notes, currentUser) {
    if (this.syncInProgress || !notes || notes.length === 0) {
      console.log('⭐ Skipping sync - already in progress or no notes');
      return { updatedNotes: [], conflicts: [] };
    }

    this.syncInProgress = true;
    if (process.env.NODE_ENV === 'development') {
      console.log(`⚡ Starting INTELLIGENT bulk sync for ${notes.length} notes`);
    }

    try {
      const results = {
        updatedNotes: [],
        conflicts: [],
        errors: [],
        newNotes: [],
        deletedNoteIds: [],
        stats: {
          totalNotes: notes.length,
          serverCalls: 0,
          skipped: 0,
          checked: 0
        }
      };

      // STEP 1: Create client metadata map with hashes
      if (process.env.NODE_ENV === 'development') {
        console.log('🔄 Step 1: Building client metadata map...');
      }
      const clientMetadata = {};
      
      // Generate hashes for all notes in parallel
      const hashPromises = notes.map(async (note) => {
        const contentHash = await this.generateContentHash(note.title, note.content);
        return {
          id: note.id,
          metadata: {
            id: note.id,
            updatedAt: note.updatedAt,
            contentHash: contentHash,
            title: note.title || '',
            shared: note.shared || false,
            hasBeenShared: note.hasBeenShared || false
          }
        };
      });
      
      const hashResults = await Promise.all(hashPromises);
      hashResults.forEach(result => {
        clientMetadata[result.id] = result.metadata;
      });
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`✅ Built metadata for ${Object.keys(clientMetadata).length} notes`);
      }

      // STEP 2: Get server metadata in ONE API call
      if (process.env.NODE_ENV === 'development') {
        console.log('🔄 Step 2: Fetching server metadata...');
      }
      let serverResponse;
      try {
        // Try new efficient endpoint first
        serverResponse = await api.get('/api/notes/sync-metadata');
        console.log('Actual serverResponse object:', serverResponse); 
        results.stats.serverCalls++;
        if (process.env.NODE_ENV === 'development') {
          console.log(`✅ Server metadata received for ${serverResponse.data.count} notes`);
        }
      } catch (error) {
        console.warn('⚠️ New sync-metadata endpoint not available, trying bulk-sync fallback...');
        console.error('Full error object:', error);
        // Fallback to existing bulk-sync with timestamp-only comparison
        try {
          const timestamps = {};
          notes.forEach(note => {
            timestamps[note.id] = note.updatedAt || new Date(0).toISOString();
          });
          
          // Generate/retrieve client ID for enhanced conflict detection
          const clientId = localStorage.getItem('clientId') || (() => {
            const newClientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            localStorage.setItem('clientId', newClientId);
            return newClientId;
          })();
          
          const bulkResponse = await api.post('/api/notes/bulk-sync', {
            noteTimestamps: timestamps,
            clientId: clientId
          });
          results.stats.serverCalls++;
          
          console.log(`✅ Bulk sync fallback returned ${Object.keys(bulkResponse.data.updates || {}).length} updates`);
          
          // Process enhanced conflict detection if available
          const updatedNotes = [];
          const conflicts = [];
          
          for (const [noteId, updateData] of Object.entries(bulkResponse.data.updates || {})) {
            console.log(`🔍 Processing bulk sync update for note ${noteId}:`, {
              hasEnhancedMetadata: !!(updateData.syncMetadata && updateData.syncMetadata.canDetectConflicts),
              serverHash: updateData.contentHash?.substring(0, 8) || updateData.syncMetadata?.serverHash?.substring(0, 8),
              clientLastKnownHash: updateData.syncMetadata?.clientLastKnownHash?.substring(0, 8)
            });
            
            if (updateData.syncMetadata && updateData.syncMetadata.canDetectConflicts) {
              // Enhanced conflict detection available
              const hasLocalChanges = await offlineStorage.hasOfflineChanges(noteId);
              const serverHash = updateData.syncMetadata.serverHash;
              const clientLastKnownHash = updateData.syncMetadata.clientLastKnownHash;
              
              const hasServerChanges = serverHash !== clientLastKnownHash;
              
              console.log(`🔍 Enhanced conflict detection for note ${noteId}:`, {
                hasLocalChanges,
                hasServerChanges,
                serverHash: serverHash?.substring(0, 8),
                clientLastKnownHash: clientLastKnownHash?.substring(0, 8),
                bothSidesChanged: hasLocalChanges && hasServerChanges
              });
              
              if (hasLocalChanges && hasServerChanges) {
                // True conflict - both sides changed, get local content for comparison
                const localNote = notes.find(n => n.id === noteId);
                conflicts.push({
                  noteId,
                  serverContent: updateData.content,
                  serverTitle: updateData.title,
                  serverUpdatedAt: updateData.updatedAt,
                  localContent: localNote?.content,
                  localTitle: localNote?.title,
                  localUpdatedAt: localNote?.updatedAt,
                  conflictReason: 'both_sides_modified'
                });
                console.log(`⚠️ True conflict detected for note ${noteId}`);
              } else if (hasLocalChanges && !hasServerChanges) {
                // Only local changes - need to push to server
                console.log(`📤 Local-only changes for note ${noteId} - need to push to server`);
                // Skip adding to updatedNotes - local version should be preserved and synced
                // TODO: Add to a "needsPush" array to trigger sync
              } else if (hasServerChanges) {
                // Only server changed - safe to update
                updatedNotes.push(updateData);
                console.log(`✅ Server-only changes for note ${noteId} - safe to update`);
              } else {
                // No changes on either side - already in sync
                console.log(`✅ Note ${noteId} is in sync`);
              }
            } else {
              // Fallback to old timestamp-based detection with offline change check
              console.log(`📊 Using fallback conflict detection for note ${noteId}`);
              
              const hasLocalChanges = await offlineStorage.hasOfflineChanges(noteId);
              console.log(`🔍 Fallback: Note ${noteId} hasLocalChanges:`, hasLocalChanges);
              
              if (hasLocalChanges) {
                // Local changes exist - should not overwrite with server data
                console.log(`📤 Fallback: Local changes detected for note ${noteId} - skipping server update to preserve local changes`);
                // Don't add to updatedNotes - preserve local version
              } else {
                // No local changes - safe to update with server data
                updatedNotes.push(updateData);
                console.log(`✅ Fallback: No local changes for note ${noteId} - safe to update with server data`);
              }
            }
          }
          
          return {
            updatedNotes,
            conflicts,
            errors: [],
            deletedNoteIds: [],
            stats: {
              ...results.stats,
              foundUpdates: updatedNotes.length,
              foundConflicts: conflicts.length,
              serverCalls: results.stats.serverCalls
            }
          };
          
        } catch (bulkError) {
          console.error('❌ Both new and bulk-sync endpoints failed:', bulkError);
          
          // Check if this is actually an offline error vs server error
          if (bulkError.message && bulkError.message.includes('Offline:')) {
            console.log('🔄 Detected offline state, using basic timestamp comparison');
            // Return notes that might need checking based on timestamps only
            const potentialUpdates = notes.filter(note => {
              // Check if note might have updates based on rough heuristics
              const timeSinceUpdate = Date.now() - new Date(note.updatedAt || 0).getTime();
              return timeSinceUpdate > 60000; // Notes older than 1 minute might have updates
            });
            
            return {
              updatedNotes: [],
              conflicts: [],
              errors: [{ error: 'Operating in limited offline mode - sync limited' }],
              deletedNoteIds: [],
              stats: {
                ...results.stats,
                totalNotes: notes.length,
                serverCalls: results.stats.serverCalls,
                skipped: notes.length - potentialUpdates.length,
                potentialUpdates: potentialUpdates.length
              }
            };
          } else {
            // For other errors, try legacy method
            console.log('🔄 Non-offline error, trying legacy bulk sync...');
            return await this.syncAllNotesLegacy(notes, currentUser);
          }
        }
      }

      const serverMetadata = serverResponse.data.metadata;
      const clientNoteIds = new Set(Object.keys(clientMetadata));
      const serverNoteIds = new Set(Object.keys(serverMetadata));
      
      // STEP 3: Intelligent filtering - find notes that actually changed
      if (process.env.NODE_ENV === 'development') {
        console.log('🔄 Step 3: Intelligent change detection...');
      }
      const notesToFetch = [];
      
      // Check each server note
      for (const [noteId, serverMeta] of Object.entries(serverMetadata)) {
        results.stats.checked++;
        const clientMeta = clientMetadata[noteId];
        
        if (!clientMeta) {
          // New note - need to fetch
          notesToFetch.push(noteId);
          console.log(`🆕 Note ${noteId} is NEW`);
        } else if (serverMeta.contentHash !== clientMeta.contentHash) {
          // Content changed - need to fetch
          notesToFetch.push(noteId);
          console.log(`🔄 Note ${noteId} CHANGED (hash: ${clientMeta.contentHash} → ${serverMeta.contentHash})`);
        } else if (new Date(serverMeta.updatedAt).getTime() > new Date(clientMeta.updatedAt || 0).getTime()) {
          // Timestamp changed but hash same - still fetch as fallback
          notesToFetch.push(noteId);
          console.log(`⏰ Note ${noteId} timestamp differs despite same hash`);
        } else {
          // No changes - identical hash and timestamp
          results.stats.skipped++;
        }
        
        clientNoteIds.delete(noteId);
      }
      
      // Notes that exist on client but not server = deleted
      results.deletedNoteIds = Array.from(clientNoteIds);
      if (results.deletedNoteIds.length > 0) {
        console.log(`🗑️ Found ${results.deletedNoteIds.length} deleted notes:`, results.deletedNoteIds);
      }

      // STEP 4: Fetch only changed notes using efficient sync endpoint
      if (notesToFetch.length > 0) {
        console.log(`🔄 Step 4: Fetching ${notesToFetch.length} changed notes (instead of all ${notes.length})...`);
        
        try {
          const syncResponse = await api.post('/api/notes/efficient-sync', {
            clientMetadata: clientMetadata, // Send ALL client metadata for comparison
            notesToFetch: notesToFetch // Send specific list of notes that need fetching
          });
          results.stats.serverCalls++;
          
          results.updatedNotes = syncResponse.data.updatedNotes || [];
          results.newNotes = syncResponse.data.newNotes || [];
          
          console.log(`✅ Efficient sync returned:`, {
            updated: results.updatedNotes.length,
            new: results.newNotes.length
          });
          
        } catch (error) {
          console.error('❌ Efficient sync failed, trying individual fetches:', error);
          // Fallback: fetch notes individually
          results.stats.serverCalls += notesToFetch.length;
          for (const noteId of notesToFetch) {
            try {
              const noteResponse = await api.get(`/api/notes/${noteId}`);
              results.updatedNotes.push(noteResponse.data);
            } catch (noteError) {
              results.errors.push({ noteId, error: noteError.message });
            }
          }
        }
      } else {
        if (process.env.NODE_ENV === 'development') {
        console.log('✅ No notes need fetching - all up to date!');
      }
      }

      // Combine updated and new notes
      const allUpdatedNotes = [...results.updatedNotes, ...results.newNotes];
      
      const efficiency = results.stats.checked > 0 ? 
        Math.round((results.stats.skipped / results.stats.checked) * 100) : 0;

      const hasChanges = results.updatedNotes.length > 0 || results.newNotes.length > 0;
      if (hasChanges || process.env.NODE_ENV === 'development') {
        console.log('✅ INTELLIGENT bulk sync complete:', {
          totalNotes: results.stats.totalNotes,
          serverCalls: results.stats.serverCalls,
          updated: results.updatedNotes.length,
          new: results.newNotes.length,
          deleted: results.deletedNoteIds.length,
          skipped: results.stats.skipped,
          efficiency: `${efficiency}% skipped`,
          conflicts: results.conflicts.length,
          errors: results.errors.length
        });
      }

      this.lastGlobalSync = Date.now();
      return {
        updatedNotes: allUpdatedNotes,
        conflicts: results.conflicts,
        errors: results.errors,
        deletedNoteIds: results.deletedNoteIds,
        stats: results.stats
      };

    } catch (error) {
      console.error('❌ Intelligent bulk sync failed:', error);
      return { updatedNotes: [], conflicts: [], errors: [{ error: error.message }] };
    } finally {
      this.syncInProgress = false;
    }
  }
  
  // Legacy fallback method (old approach) - ENHANCED with offline handling
  async syncAllNotesLegacy(notes, currentUser) {
    console.log('🔄 Using LEGACY bulk sync approach...');
    
    const results = {
      updatedNotes: [],
      conflicts: [],
      errors: []
    };

    // Check connectivity before proceeding
    let isOnline = true;
    try {
      const api = (await import('../utils/api')).default;
      isOnline = await api.forceConnectivityTest();
    } catch (error) {
      console.log('⚠️ Connectivity test failed in legacy sync');
      isOnline = false;
    }

    if (!isOnline) {
      console.log('📴 Legacy sync detected offline state - returning cached notes only');
      return {
        updatedNotes: [],
        conflicts: [],
        errors: [{ error: 'Legacy sync: offline mode - no server communication possible' }],
        stats: {
          totalNotes: notes.length,
          serverCalls: 0,
          updated: 0,
          conflicts: 0,
          errors: 1,
          skipped: notes.length
        }
      };
    }

    // Process notes in parallel but limit concurrency
    const batchSize = 3; // Reduced batch size for more reliable processing
    let offlineErrorCount = 0;
    
    for (let i = 0; i < notes.length; i += batchSize) {
      const batch = notes.slice(i, i + batchSize);
      const batchPromises = batch.map(note => this.checkNoteForUpdates(note, currentUser));
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        const note = batch[index];
        if (result.status === 'fulfilled' && result.value) {
          const { hasUpdates, conflict, updatedNote, error } = result.value;
          
          if (error) {
            results.errors.push({ noteId: note.id, error });
            
            // Count offline errors to determine if we should stop
            if (error.includes('Offline:')) {
              offlineErrorCount++;
            }
          } else if (conflict) {
            results.conflicts.push({ note, conflict });
          } else if (hasUpdates && updatedNote) {
            results.updatedNotes.push(updatedNote);
          }
        } else {
          results.errors.push({ 
            noteId: note.id, 
            error: result.reason?.message || 'Unknown error' 
          });
        }
      });

      // If too many offline errors, stop processing
      if (offlineErrorCount >= 3) {
        console.log('❌ Too many offline errors in legacy sync, stopping early');
        break;
      }

      // Small delay between batches to avoid overwhelming the server
      if (i + batchSize < notes.length) {
        await new Promise(resolve => setTimeout(resolve, 200)); // Slightly longer delay
      }
    }

    console.log('✅ Legacy bulk sync complete:', {
      totalNotes: notes.length,
      updated: results.updatedNotes.length,
      conflicts: results.conflicts.length,
      errors: results.errors.length,
      offlineErrors: offlineErrorCount
    });

    return {
      ...results,
      stats: {
        totalNotes: notes.length,
        serverCalls: Math.min(notes.length, Math.max(0, notes.length - offlineErrorCount)),
        updated: results.updatedNotes.length,
        conflicts: results.conflicts.length,
        errors: results.errors.length
      }
    };
  }

  // Check a single note for updates with enhanced conflict detection
  async checkNoteForUpdates(note, currentUser) {
    try {
      console.log(`🔍 Checking note ${note.id} for updates since ${note.updatedAt}`);
      
      // First, check if we have offline changes that need conflict detection
      const offlineStorage = (await import('../utils/offlineStorage')).default;
      const offlineChanges = await offlineStorage.checkForOfflineChanges(note);
      
      const response = await api.get(`/api/notes/${note.id}/updates?since=${note.updatedAt}`);
      const { content, title, updatedAt, lastEditor, contentHash: serverHash } = response.data;

      console.log(`🔍 Server response for note ${note.id}:`, {
        hasContent: !!content,
        contentLength: content?.length,
        contentPreview: content?.substring(0, 100) + '...',
        hasTitle: !!title,
        title: title,
        serverUpdatedAt: updatedAt,
        noteUpdatedAt: note.updatedAt,
        lastEditor: lastEditor?.name || 'Unknown',
        serverHash,
        offlineChanges: offlineChanges.hasChanges
      });

      // No updates if server timestamp is same or older
      if (!updatedAt || new Date(updatedAt).getTime() <= new Date(note.updatedAt).getTime()) {
        console.log(`⭐ No updates for note ${note.id} - server time: ${updatedAt}, note time: ${note.updatedAt}`);
        return { hasUpdates: false };
      }

      // Skip if this was our own update (within last 10 seconds)
      if (lastEditor?.id === currentUser?.id) {
        const timeSinceEdit = Date.now() - new Date(updatedAt).getTime();
        if (timeSinceEdit < 10000) {
          console.log(`⭐ Skipping own recent update for note ${note.id} (${timeSinceEdit}ms ago)`);
          return { hasUpdates: false };
        }
      }

      console.log(`📥 Found updates for note ${note.id}:`, {
        oldUpdatedAt: note.updatedAt,
        newUpdatedAt: updatedAt,
        lastEditor: lastEditor?.name || 'Unknown',
        contentChanged: note.content !== content,
        titleChanged: note.title !== title
      });

      // ENHANCED CONFLICT DETECTION: Check if we have local changes AND server changed
      const hasLocalChanges = this.pendingNotes.has(note.id) || offlineChanges.hasChanges;
      
      if (hasLocalChanges) {
        // Compare original hash with server hash to detect conflicts
        const originalHash = offlineChanges.originalHash || note.originalHash;
        const currentServerHash = serverHash || await this.generateContentHash(title, content);
        
        console.log(`🔍 Conflict analysis for note ${note.id}:`, {
          hasLocalChanges,
          originalHash,
          currentServerHash,
          hashesMatch: originalHash === currentServerHash,
          currentLocalHash: offlineChanges.currentHash
        });
        
        // If original hash matches server hash, safe to sync (user's changes on top of same base)
        if (originalHash && originalHash === currentServerHash) {
          console.log(`✅ Safe to sync note ${note.id} - user changed same version as server`);
          // Proceed with normal update
        } else {
          console.log(`⚠️ CONFLICT detected for note ${note.id} - both client and server changed from different base versions`);
          return {
            hasUpdates: true,
            conflict: {
              localNote: note,
              remoteContent: content,
              remoteTitle: title,
              remoteUpdatedAt: updatedAt,
              lastEditor,
              originalHash,
              serverHash: currentServerHash,
              localHash: offlineChanges.currentHash,
              conflictType: 'hash_mismatch'
            }
          };
        }
      }

      // No conflict - return updated note
      const updatedNote = {
        ...note,
        title: title !== undefined ? title : note.title,
        content: content !== undefined ? content : note.content,
        updatedAt,
        lastEditedBy: lastEditor?.id,
        lastEditorName: lastEditor?.name,
        lastEditorAvatar: lastEditor?.avatar,
        originalHash: serverHash || await this.generateContentHash(title, content) // Update original hash after sync
      };
      
      console.log(`✅ Returning updated note ${note.id}:`, {
        titleChanged: note.title !== updatedNote.title,
        contentChanged: note.content !== updatedNote.content,
        newContentLength: updatedNote.content?.length
      });
      
      return {
        hasUpdates: true,
        updatedNote
      };

    } catch (error) {
      if (error.response?.status === 429) {
        console.log(`⏸️ Rate limited checking note ${note.id}`);
        return { hasUpdates: false };
      }
      
      console.error(`❌ Error checking note ${note.id}:`, error);
      return { hasUpdates: false, error: error.message };
    }
  }

  // Mark a note as having pending local changes
  markNotePending(noteId) {
    this.pendingNotes.add(noteId);
    console.log(`📝 Marked note ${noteId} as having pending changes`);
  }

  // Clear pending status for a note (after successful save)
  clearNotePending(noteId) {
    this.pendingNotes.delete(noteId);
    console.log(`✅ Cleared pending status for note ${noteId}`);
  }

  // Get sync statistics
  getSyncStats() {
    return {
      lastGlobalSync: this.lastGlobalSync,
      syncInProgress: this.syncInProgress,
      pendingNotesCount: this.pendingNotes.size,
      pendingNotes: Array.from(this.pendingNotes)
    };
  }
}

// Export singleton instance
export const syncService = new SyncService();

// =============================================================================
// CONFLICT RESOLUTION STRATEGIES - All go in this same file
// =============================================================================

export const ConflictResolutionStrategies = {
  // Strategy 1: Smart merge for lists (like shopping lists)
  smartMergeList: (localContent, remoteContent) => {
    try {
      // Extract list items from both versions
      const localItems = extractListItems(localContent);
      const remoteItems = extractListItems(remoteContent);
      
      // Find unique items from both lists
      const allItems = new Set([...localItems, ...remoteItems]);
      
      // Rebuild as a clean list
      const mergedContent = Array.from(allItems)
        .filter(item => item.trim()) // Remove empty items
        .map(item => `* ${item}`)
        .join('\n');
      
      console.log('🔄 Smart list merge:', {
        localItems: localItems.length,
        remoteItems: remoteItems.length,
        mergedItems: allItems.size
      });
      
      return mergedContent;
    } catch (error) {
      console.error('❌ Smart merge failed, falling back to simple merge');
      return ConflictResolutionStrategies.simpleMerge(localContent, remoteContent);
    }
  },

  // Strategy 2: Time-based merge (newer wins for each paragraph)
  timeMerge: (localContent, remoteContent, remoteTimestamp) => {
    try {
      // For now, just use the newer content
      // In a real implementation, you'd track paragraph-level timestamps
      const localTime = Date.now() - 30000; // Assume local changes are recent
      const remoteTime = new Date(remoteTimestamp).getTime();
      
      if (remoteTime > localTime) {
        console.log('🕐 Using remote content (newer)');
        return remoteContent;
      } else {
        console.log('🕐 Using local content (newer)');
        return localContent;
      }
    } catch (error) {
      return remoteContent; // Default to remote
    }
  },

  // Strategy 3: Simple append (safest but can create duplicates)
  simpleMerge: (localContent, remoteContent) => {
    return `${localContent}\n\n--- Remote changes ---\n${remoteContent}`;
  },

  // Strategy 4: Intelligent merge based on content type
  intelligentMerge: (localContent, remoteContent, context = {}) => {
    // Detect content type
    const isShoppingList = /^\s*[\*\-\+]\s+/m.test(localContent) && /^\s*[\*\-\+]\s+/m.test(remoteContent);
    const isTodoList = /^\s*[\*\-\+]\s*\[[\sx]\]/m.test(localContent);
    
    if (isShoppingList || isTodoList) {
      return ConflictResolutionStrategies.smartMergeList(localContent, remoteContent);
    } else {
      return ConflictResolutionStrategies.timeMerge(localContent, remoteContent, context.remoteTimestamp);
    }
  }
};

// =============================================================================
// HELPER FUNCTIONS - Also go in this same file
// =============================================================================

// Helper function to extract list items
function extractListItems(content) {
  const lines = content.split('\n');
  const items = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Match bullet points: *, -, +, or checkbox items
    const match = trimmed.match(/^[\*\-\+]\s*(?:\[[\sx]\]\s*)?(.+)$/);
    if (match) {
      const item = match[1].trim();
      if (item && !items.includes(item)) {
        items.push(item);
      }
    }
  }
  
  return items;
}
