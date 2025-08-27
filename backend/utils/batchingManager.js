// utils/batchingManager.js - Server-side batching for real-time note updates
const fs = require('fs-extra');
const path = require('path');
const fastDiff = require('fast-diff');


class BatchingManager {
  constructor() {
    this.batchQueue = new Map(); // noteId -> { updates, lastEditor, timer }
    this.batchDelay = 2000; // 2 seconds - shorter than client auto-save
    this.maxBatchSize = 50; // Flush after this many updates
    this.debug = process.env.NODE_ENV !== 'production';
    this.io = null; // Will be set by server.js
  }

  // Set Socket.IO instance for sending confirmations
  setSocketIO(ioInstance) {
    this.io = ioInstance;
    console.log('📡 [BATCH] Socket.IO instance configured for save confirmations');
  }
  
  // Diff utility functions
  generateContentDiff(oldContent, newContent) {
    if (oldContent === newContent) return null;
    
    const diffs = fastDiff(oldContent, newContent);
    const patches = [];
    let position = 0;
    
    for (const [operation, text] of diffs) {
      if (operation === fastDiff.INSERT) {
        patches.push({ op: 'insert', pos: position, text });
      } else if (operation === fastDiff.DELETE) {
        patches.push({ op: 'delete', pos: position, length: text.length });
        position += text.length;
      } else {
        // EQUAL - move position forward
        position += text.length;
      }
    }
    
    return patches.length > 0 ? patches : null;
  }
  
  applyContentDiff(content, patches) {
    if (!patches || patches.length === 0) {
      console.log('📦 [SERVER-DIFF] No patches to apply, returning original content');
      return content;
    }
    
    console.log('🔧 [SERVER-DIFF] Applying patches to server content:', {
      originalLength: content.length,
      patchCount: patches.length,
      originalPreview: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
      patches: patches.map(p => ({ op: p.op, pos: p.pos, length: p.length, text: p.text?.substring(0, 20) + (p.text?.length > 20 ? '...' : '') }))
    });
    
    let result = content;
    try {
      // Apply patches in reverse order to maintain positions
      for (let i = patches.length - 1; i >= 0; i--) {
        const patch = patches[i];
        
        console.log(`🔧 [SERVER-DIFF] Applying patch ${i}:`, {
          op: patch.op,
          pos: patch.pos,
          length: patch.length,
          text: patch.text?.substring(0, 30),
          resultLengthBefore: result.length
        });
        
        if (patch.op === 'insert') {
          // Validate insert position
          if (patch.pos > result.length) {
            console.error('❌ [SERVER-DIFF] Insert position beyond content length:', {
              position: patch.pos,
              contentLength: result.length,
              patch
            });
            continue; // Skip invalid patch
          }
          
          const before = result.slice(0, patch.pos);
          const after = result.slice(patch.pos);
          result = before + patch.text + after;
          
          console.log('➕ [SERVER-DIFF] Insert applied successfully:', {
            position: patch.pos,
            insertText: patch.text,
            resultLength: result.length
          });
          
        } else if (patch.op === 'delete') {
          // Validate delete range
          if (patch.pos + patch.length > result.length) {
            console.error('❌ [SERVER-DIFF] Delete range beyond content length:', {
              position: patch.pos,
              deleteLength: patch.length,
              contentLength: result.length,
              patch
            });
            continue; // Skip invalid patch
          }
          
          const deletedText = result.slice(patch.pos, patch.pos + patch.length);
          const before = result.slice(0, patch.pos);
          const after = result.slice(patch.pos + patch.length);
          result = before + after;
          
          console.log('➖ [SERVER-DIFF] Delete applied successfully:', {
            position: patch.pos,
            deleteLength: patch.length,
            deletedText: deletedText.substring(0, 30),
            resultLength: result.length
          });
        }
        
        // Basic HTML validation after each patch
        if (!this.isValidHtml(result)) {
          console.error('❌ [SERVER-DIFF] Invalid HTML detected after patch, reverting:', {
            patchIndex: i,
            patch,
            resultPreview: result.substring(0, 200)
          });
          return content; // Revert to original if HTML becomes invalid
        }
      }
      
      console.log('✅ [SERVER-DIFF] All patches applied successfully:', {
        originalLength: content.length,
        resultLength: result.length,
        changed: result !== content,
        resultPreview: result.substring(0, 100) + (result.length > 100 ? '...' : '')
      });
      
    } catch (error) {
      console.error('❌ [SERVER-DIFF] Error applying patches, reverting to original:', error);
      return content;
    }
    
    return result;
  }

  // Simple HTML validation for server-side diff application
  isValidHtml(html) {
    try {
      if (!html || typeof html !== 'string') return false;
      
      // Check for malformed tags (e.g., "<2/p>", "3/p>")
      const malformedTagPattern = /<[^a-zA-Z\/!]/;
      if (malformedTagPattern.test(html)) {
        console.log('❌ [SERVER-HTML-VALID] Malformed tag detected:', html.match(malformedTagPattern)?.[0]);
        return false;
      }
      
      // Check for tags that got broken by character-level operations
      const brokenTagPattern = /[0-9]+\/[a-zA-Z]+>/;
      if (brokenTagPattern.test(html)) {
        console.log('❌ [SERVER-HTML-VALID] Broken tag structure detected:', html.match(brokenTagPattern)?.[0]);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('❌ [SERVER-HTML-VALID] Validation error:', error);
      return false;
    }
  }

  async addUpdate(noteId, updates, editor) {
    if (this.debug) {
      console.log(`📦 [BATCH] Adding update to queue for note ${noteId}:`, {
        hasTitle: !!updates.title,
        hasContent: !!updates.content,
        hasContentDiff: !!updates.contentDiff,
        isDiffBased: !!updates.contentDiff,
        editorName: editor?.name || 'Unknown'
      });
    }

    // Get or create batch for this note
    let batch = this.batchQueue.get(noteId);
    if (!batch) {
      batch = {
        noteId,
        updates: {},
        updateCount: 0,
        lastEditor: null,
        editors: new Set(), // Track all editors who contributed to this batch
        timer: null,
        createdAt: Date.now()
      };
      this.batchQueue.set(noteId, batch);
    }

    // Clear existing timer
    if (batch.timer) {
      clearTimeout(batch.timer);
    }

    // Merge updates (latest wins for each field)
    if (updates.title !== undefined) {
      batch.updates.title = updates.title;
    }
    
    // Handle content vs contentDiff - prioritize diff-based updates
    if (updates.contentDiff) {
      // If we don't have accumulated content, we need to read the current file content
      if (!batch.updates.content && !batch.accumulatedContentDiffs) {
        try {
          const originalNoteInfo = await this.findOriginalNoteInfo(editor.userId || editor.id, noteId);
          if (originalNoteInfo) {
            const currentContent = await fs.readFile(originalNoteInfo.noteFile, 'utf8').catch(() => '');
            batch.updates.content = currentContent;
            batch.accumulatedContentDiffs = [];
          }
        } catch (error) {
          console.error(`❌ [BATCH] Failed to read current content for diff application:`, error);
          // Fallback - treat as regular content update if we can't read the file
          if (updates.content !== undefined) {
            batch.updates.content = updates.content;
          }
          return;
        }
      }
      
      // Initialize accumulated diffs if needed
      if (!batch.accumulatedContentDiffs) {
        batch.accumulatedContentDiffs = [];
      }
      
      // CRITICAL FIX: Only apply the NEW diff, not re-apply all accumulated diffs
      const currentContent = batch.updates.content || '';
      
      console.log('🔧 [BATCH] Applying NEW diff only (not re-applying accumulated):', {
        currentContentLength: currentContent.length,
        newDiffPatches: updates.contentDiff.length,
        previouslyAccumulated: batch.accumulatedContentDiffs ? batch.accumulatedContentDiffs.length : 0
      });
      
      try {
        // Apply only the new diff to the current accumulated content
        const finalContent = this.applyContentDiff(currentContent, updates.contentDiff);
        batch.updates.content = finalContent;
        
        // Track this diff for debugging (but don't re-apply it)
        batch.accumulatedContentDiffs.push(updates.contentDiff);
        
        console.log('✅ [BATCH] Successfully applied new diff:', {
          resultLength: finalContent.length,
          totalDiffsTracked: batch.accumulatedContentDiffs.length
        });
        
      } catch (error) {
        console.error('❌ [BATCH] Failed to apply new diff, keeping current content:', error);
        // Keep current content if diff application fails
      }
      
      if (this.debug) {
        console.log(`📦 [BATCH] Applied diff to batch content:`, {
          diffPatches: updates.contentDiff.length,
          accumulatedDiffs: batch.accumulatedContentDiffs.length,
          finalContentLength: finalContent.length
        });
      }
    } else if (updates.content !== undefined) {
      // Full content update - clear any accumulated diffs
      batch.updates.content = updates.content;
      batch.accumulatedContentDiffs = [];
      
      if (this.debug) {
        console.log(`📄 [BATCH] Full content update (legacy mode), cleared accumulated diffs`);
      }
    }
    
    // Track this editor in the batch
    const editorId = editor?.userId || editor?.id;
    if (editorId) {
      batch.editors.add(editorId);
    }
    
    batch.lastEditor = editor;
    batch.updateCount++;
    batch.lastUpdated = Date.now();

    // Set new timer for batch processing
    batch.timer = setTimeout(() => {
      this.processBatch(noteId);
    }, this.batchDelay);

    // Force flush if batch gets too large
    if (batch.updateCount >= this.maxBatchSize) {
      if (this.debug) {
        console.log(`📦 [BATCH] Force flushing large batch for note ${noteId} (${batch.updateCount} updates)`);
      }
      await this.processBatch(noteId);
    }
  }

  async processBatch(noteId) {
    const batch = this.batchQueue.get(noteId);
    if (!batch) {
      return;
    }

    console.log(`📦 [BATCH] Processing batch for note ${noteId}:`, {
      updateCount: batch.updateCount,
      hasTitle: !!batch.updates.title,
      hasContent: !!batch.updates.content,
      accumulatedDiffs: batch.accumulatedContentDiffs ? batch.accumulatedContentDiffs.length : 0,
      editorName: batch.lastEditor?.name || 'Unknown',
      batchAge: Date.now() - batch.createdAt,
      editors: Array.from(batch.editors)
    });

    try {
      // Clear timer and remove from queue
      if (batch.timer) {
        clearTimeout(batch.timer);
      }
      this.batchQueue.delete(noteId);

      // Save to database - reuse existing note saving logic
      const savedResult = await this.saveNoteUpdates(noteId, batch.updates, batch.lastEditor);
      
      console.log(`✅ [BATCH] Successfully saved batch for note ${noteId}`);

      // Send save confirmation to all editors who contributed to this batch
      if (this.io) {
        const confirmationData = {
          noteId,
          savedAt: savedResult.updatedAt,
          confirmedContent: savedResult.content, // Include confirmed content for baseline sync
          batchId: `${noteId}_${batch.createdAt}`, // Unique identifier for this batch
          updateCount: batch.updateCount,
          success: true
        };

        console.log(`📡 [BATCH] Broadcasting save confirmation for note ${noteId} to ${batch.editors.size} editors`);
        
        // Broadcast to all clients in the note room - they'll filter by their own noteId
        this.io.to(`note:${noteId}`).emit('batch-saved', confirmationData);
        
        console.log(`✅ [BATCH] Save confirmation sent for note ${noteId}`);
      }

    } catch (error) {
      console.error(`❌ [BATCH] Failed to save batch for note ${noteId}:`, error);
      
      // Re-queue with exponential backoff on failure
      setTimeout(() => {
        this.addUpdate(noteId, batch.updates, batch.lastEditor);
      }, this.batchDelay * 2);
    }
  }

  async saveNoteUpdates(noteId, updates, editor) {
    const userId = editor?.userId || editor?.id;
    
    if (!userId) {
      throw new Error('Editor userId required for batch save');
    }

    // Use existing findOriginalNoteInfo logic to handle shared notes properly
    const originalNoteInfo = await this.findOriginalNoteInfo(userId, noteId);
    
    if (!originalNoteInfo) {
      throw new Error(`Note not found or no access: ${noteId} for user ${userId}`);
    }

    const { noteFile, metadata, metadataFile, allMetadata } = originalNoteInfo;

    // Read current note content (pure HTML format, not markdown with metadata)
    const currentContent = await fs.readFile(noteFile, 'utf8');
    
    // Use new content if provided, otherwise keep current
    const finalContent = updates.content !== undefined ? updates.content : currentContent;

    // Write the file atomically (content only, no metadata headers)
    const tempFile = noteFile + '.tmp';
    await fs.writeFile(tempFile, finalContent, 'utf8');
    await fs.move(tempFile, noteFile, { overwrite: true });

    // Update metadata.json with new timestamp and other changes
    const updatedAt = new Date().toISOString();
    const updatedMetadata = {
      ...metadata,
      updatedAt: updatedAt,
      lastEditedBy: userId,
      lastEditorName: editor?.name || 'Unknown',
      lastEditorAvatar: editor?.avatar || ''
    };

    // Update title if provided
    if (updates.title !== undefined) {
      updatedMetadata.title = updates.title;
    }

    // Update the metadata in the allMetadata object
    allMetadata[originalNoteInfo.noteId] = updatedMetadata;

    // Write updated metadata.json
    await fs.writeJson(metadataFile, allMetadata, { spaces: 2 });

    // Sync changes to all shared copies (content + metadata)
    if (metadata.hasBeenShared || metadata.shared) {
      await this.syncSharedNoteUpdates(originalNoteInfo, updatedMetadata, finalContent);
    }

    if (this.debug) {
      console.log(`💾 [BATCH] Saved note ${noteId} with updates:`, {
        titleChanged: updates.title !== undefined,
        contentChanged: updates.content !== undefined,
        wasDiffBased: !!(batch.accumulatedContentDiffs && batch.accumulatedContentDiffs.length > 0),
        totalDiffsApplied: batch.accumulatedContentDiffs ? batch.accumulatedContentDiffs.length : 0,
        newUpdatedAt: updatedAt,
        isShared: originalNoteInfo.isShared,
        noteFile,
        contentLength: finalContent?.length || 0
      });
    }

    return {
      id: noteId,
      title: updatedMetadata.title,
      content: finalContent,
      updatedAt: updatedAt,
      shared: metadata.shared || false,
      hasBeenShared: metadata.hasBeenShared || false,
      lastEditedBy: userId,
      lastEditorName: editor?.name || 'Unknown'
    };
  }

  // Copy of findOriginalNoteInfo from routes/notes.js to handle shared notes
  async findOriginalNoteInfo(userId, noteId) {
    try {
      const userNotesDir = path.join(__dirname, '../data/notes', userId);
      const metadataFile = path.join(userNotesDir, 'metadata.json');
      const metadata = await fs.readJson(metadataFile).catch(() => ({}));
      const noteMetadata = metadata[noteId];

      if (!noteMetadata) return null;

      // If this is a shared note, find the original
      if (noteMetadata.shared && noteMetadata.originalNoteId && noteMetadata.sharedBy) {
        console.log('🔍 [BATCH] Finding original note info for shared note:', {
          noteId,
          originalNoteId: noteMetadata.originalNoteId,
          sharedBy: noteMetadata.sharedBy,
          userId
        });

        const usersFile = path.join(__dirname, '../data/users.json');
        const users = await fs.readJson(usersFile).catch(() => ({}));
        
        const originalOwner = Object.values(users).find(u => u.email === noteMetadata.sharedBy);
        if (!originalOwner) {
          console.error('❌ [BATCH] Could not find original owner with email:', noteMetadata.sharedBy);
          return null;
        }

        const originalOwnerDir = path.join(__dirname, '../data/notes', originalOwner.id);
        const originalMetadataFile = path.join(originalOwnerDir, 'metadata.json');
        const originalMetadata = await fs.readJson(originalMetadataFile).catch(() => ({}));
        
        const originalNoteMetadata = originalMetadata[noteMetadata.originalNoteId];
        
        if (originalNoteMetadata) {
          const originalNoteFile = path.join(originalOwnerDir, `${noteMetadata.originalNoteId}.md`);
          
          return {
            noteFile: originalNoteFile,
            metadata: originalNoteMetadata,
            metadataFile: originalMetadataFile,
            allMetadata: originalMetadata,
            isShared: true,
            ownerId: originalOwner.id,
            noteId: noteMetadata.originalNoteId,
            sharedNoteId: noteId
          };
        }
      } else {
        // Regular note owned by this user
        const noteFile = path.join(userNotesDir, `${noteId}.md`);
        
        if (await fs.pathExists(noteFile)) {
          return {
            noteFile,
            metadata: noteMetadata,
            metadataFile,
            allMetadata: metadata,
            isShared: false,
            ownerId: userId,
            noteId: noteId
          };
        }
      }

      return null;
    } catch (error) {
      console.error('❌ [BATCH] Error finding original note info:', error);
      return null;
    }
  }

  // Get stats for monitoring
  getBatchStats() {
    const stats = {
      queueSize: this.batchQueue.size,
      oldestBatch: null,
      totalUpdates: 0
    };

    let oldestTime = Date.now();
    for (const batch of this.batchQueue.values()) {
      stats.totalUpdates += batch.updateCount;
      if (batch.createdAt < oldestTime) {
        oldestTime = batch.createdAt;
        stats.oldestBatch = {
          noteId: batch.noteId,
          age: Date.now() - batch.createdAt,
          updateCount: batch.updateCount
        };
      }
    }

    return stats;
  }

  // Force flush all pending batches (useful for graceful shutdown)
  async flushAll() {
    console.log(`📦 [BATCH] Force flushing all ${this.batchQueue.size} pending batches...`);
    
    const promises = [];
    for (const noteId of this.batchQueue.keys()) {
      promises.push(this.processBatch(noteId));
    }
    
    await Promise.all(promises);
    console.log(`✅ [BATCH] All batches flushed`);
  }

  // Sync shared note updates to all participants (content + metadata)
  async syncSharedNoteUpdates(originalNoteInfo, updatedMetadata, content) {
    if (!originalNoteInfo.metadata.hasBeenShared && !updatedMetadata.shared) return;

    try {
      console.log('🔄 [BATCH] Syncing shared note updates:', {
        noteId: originalNoteInfo.noteId,
        hasBeenShared: originalNoteInfo.metadata.hasBeenShared,
        updatedAt: updatedMetadata.updatedAt
      });

      const sharesFile = path.join(__dirname, '../data/shares.json');
      const shares = await fs.readJson(sharesFile).catch(() => ({}));
      
      const shareKey = `${originalNoteInfo.ownerId}-${originalNoteInfo.noteId}`;
      const shareInfo = shares[shareKey];
      
      if (!shareInfo || !shareInfo.participants) {
        console.log('🔍 [BATCH] No share info found for:', shareKey);
        return;
      }

      console.log('👥 [BATCH] Found participants to sync:', Object.keys(shareInfo.participants));
      
      // Update each participant's content AND metadata
      for (const [participantId, participantInfo] of Object.entries(shareInfo.participants)) {
        try {
          const participantNotesDir = path.join(__dirname, '../data/notes', participantId);
          const participantMetadataFile = path.join(participantNotesDir, 'metadata.json');
          const participantMetadata = await fs.readJson(participantMetadataFile).catch(() => ({}));
          
          let participantNoteId = null;
          for (const [noteId, noteData] of Object.entries(participantMetadata)) {
            if (noteData.originalNoteId === originalNoteInfo.noteId || 
                (noteData.shared && noteId === originalNoteInfo.noteId)) {
              participantNoteId = noteId;
              break;
            }
          }
          
          if (participantNoteId && participantMetadata[participantNoteId]) {
            // Update metadata
            participantMetadata[participantNoteId] = {
              ...participantMetadata[participantNoteId],
              title: updatedMetadata.title,
              updatedAt: updatedMetadata.updatedAt,
              lastEditedBy: updatedMetadata.lastEditedBy,
              lastEditorName: updatedMetadata.lastEditorName,
              lastEditorAvatar: updatedMetadata.lastEditorAvatar
            };
            
            await fs.writeJson(participantMetadataFile, participantMetadata);
            
            // CRUCIAL: Also update the content file
            const participantNoteFile = path.join(participantNotesDir, `${participantNoteId}.md`);
            const tempFile = participantNoteFile + '.tmp';
            await fs.writeFile(tempFile, content, 'utf8');
            await fs.move(tempFile, participantNoteFile, { overwrite: true });
            
            console.log(`✅ [BATCH] Synced note content AND metadata to participant ${participantId} (note ${participantNoteId})`);
          } else {
            console.log(`❌ [BATCH] Could not find note ${originalNoteInfo.noteId} in participant ${participantId}'s metadata`);
          }
          
        } catch (error) {
          console.error(`❌ [BATCH] Failed to sync to participant ${participantId}:`, error);
        }
      }
      
    } catch (error) {
      console.error('❌ [BATCH] Error syncing shared note updates:', error);
    }
  }
}

// Export singleton instance
module.exports = new BatchingManager();