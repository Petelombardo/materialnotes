const express = require('express');
const passport = require('passport');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const fileLockManager = require('../utils/fileLock');
const collaborationManager = require('../utils/collaborationManager');
const router = express.Router();

// ===== MIDDLEWARE SETUP =====
async function safeCollaborationOperation(operation, fallbackValue = null) {
  try {
    if (!collaborationManager) {
      console.warn('⚠️ collaborationManager not available, using fallback');
      return fallbackValue;
    }
    return await operation();
  } catch (error) {
    console.error('❌ Collaboration operation failed:', error.message);
    return fallbackValue;
  }
}


// Mobile detection middleware
const mobileDetectionMiddleware = (req, res, next) => {
  const userAgent = req.get('User-Agent') || '';
  const isMobile = /Mobile|Android|iPhone|iPad|webOS|BlackBerry|Windows Phone/i.test(userAgent);
  req.isMobile = isMobile;
  console.log(`📱 Device detection: ${isMobile ? 'Mobile' : 'Desktop'} - ${userAgent.substring(0, 50)}...`);
  next();
};

// Enhanced rate limiting with mobile-specific considerations
const collaborationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: (req) => {
    // More generous limits for mobile devices and bulk operations
    if (req.path.includes('/bulk-sync')) return req.isMobile ? 10 : 5;
    return req.isMobile ? 60 : 30;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const device = req.isMobile ? 'mobile' : 'desktop';
    return `${req.user?.id || req.ip}:${req.params.noteId || 'bulk'}:${device}`;
  },
  message: {
    error: 'Too many collaboration requests, please slow down.',
    retryAfter: 60,
    hint: req => req.isMobile ? 'Mobile apps may sync aggressively after resuming' : 'Try reducing polling frequency'
  },
  skip: (req) => {
    // Skip rate limiting for simple GET requests that don't involve real-time collaboration
    return req.method === 'GET' && 
           !req.path.includes('/updates') && 
           !req.path.includes('/presence') && 
           !req.path.includes('/heartbeat');
  }
});

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Middleware to authenticate all note routes
router.use(passport.authenticate('jwt', { session: false }));

// Apply mobile detection to all routes
router.use(mobileDetectionMiddleware);

// ===== HELPER FUNCTIONS =====

// Helper function to resolve actual file path (handles symlinks)
async function resolveNotePath(noteFilePath) {
  try {
    const stats = await fs.lstat(noteFilePath);
    if (stats.isSymbolicLink()) {
      return await fs.realpath(noteFilePath);
    }
    return noteFilePath;
  } catch (error) {
    return noteFilePath;
  }
}

// Enhanced helper function to find the original note file and metadata for shared notes
async function findOriginalNoteInfo(userId, noteId) {
  try {
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];

    if (!noteMetadata) return null;

    // If this is a shared note, find the original
    if (noteMetadata.shared && noteMetadata.originalNoteId && noteMetadata.sharedBy) {
      console.log('🔍 Finding original note info for shared note:', {
        noteId,
        originalNoteId: noteMetadata.originalNoteId,
        sharedBy: noteMetadata.sharedBy,
        userId
      });

      const usersFile = path.join(__dirname, '../data/users.json');
      const users = await fs.readJson(usersFile).catch(() => ({}));
      
      const originalOwner = Object.values(users).find(u => u.email === noteMetadata.sharedBy);
      if (!originalOwner) {
        console.error('❌ Could not find original owner with email:', noteMetadata.sharedBy);
        return null;
      }

      console.log('👤 Found original owner:', originalOwner.id);

      const originalOwnerDir = path.join(__dirname, '../data/notes', originalOwner.id);
      const originalMetadataFile = path.join(originalOwnerDir, 'metadata.json');
      const originalMetadata = await fs.readJson(originalMetadataFile).catch(() => ({}));
      
      const originalNoteMetadata = originalMetadata[noteMetadata.originalNoteId];
      
      if (originalNoteMetadata) {
        const originalNoteFile = path.join(originalOwnerDir, `${noteMetadata.originalNoteId}.md`);
        
        console.log('✅ Found original note info:', {
          originalNoteId: noteMetadata.originalNoteId,
          ownerId: originalOwner.id,
          updatedAt: originalNoteMetadata.updatedAt
        });
        
        return {
          noteFile: originalNoteFile,
          metadata: originalNoteMetadata,
          metadataFile: originalMetadataFile,
          allMetadata: originalMetadata,
          noteId: noteMetadata.originalNoteId,
          ownerId: originalOwner.id,
          isShared: true
        };
      } else {
        console.error('❌ Could not find original note metadata for:', noteMetadata.originalNoteId);
        return null;
      }
    }

    // This is an original note
    const noteFile = path.join(userNotesDir, `${noteId}.md`);
    
    console.log('🔍 This is an original note:', {
      noteId,
      ownerId: userId,
      hasBeenShared: noteMetadata.hasBeenShared,
      updatedAt: noteMetadata.updatedAt
    });
    
    return {
      noteFile,
      metadata: noteMetadata,
      metadataFile,
      allMetadata: metadata,
      noteId,
      ownerId: userId,
      isShared: false
    };
  } catch (error) {
    console.error('❌ Error finding original note info:', error);
    return null;
  }
}

// Helper function to check if user has permission to edit note
async function checkEditPermission(userId, noteId) {
  try {
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];

    if (!noteMetadata) return false;
    
    if (noteMetadata.shared) {
      return noteMetadata.permission === 'edit';
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

// Helper function to check if user has access to note (view or edit)
async function checkNoteAccess(userId, noteId) {
  try {
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    return !!metadata[noteId];
  } catch (error) {
    return false;
  }
}

// Helper function to get image directory for a note
function getImageDir(userId, noteId) {
  return path.join(__dirname, '../data/notes', userId, 'images', noteId);
}

// Helper function to process and save image
async function processAndSaveImage(imageBuffer, userId, noteId, originalName) {
  const imageId = uuidv4();
  const imageDir = getImageDir(userId, noteId);
  await fs.ensureDir(imageDir);
  
  const ext = path.extname(originalName).toLowerCase() || '.jpg';
  const filename = `${imageId}${ext}`;
  const filepath = path.join(imageDir, filename);
  
  let processedBuffer;
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  
  if (metadata.width > 1200) {
    processedBuffer = await image
      .resize(1200, null, { withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } else {
    processedBuffer = await image
      .jpeg({ quality: 85 })
      .toBuffer();
  }
  
  await fs.writeFile(filepath, processedBuffer);
  
  return {
    id: imageId,
    filename,
    originalName,
    size: processedBuffer.length,
    width: metadata.width > 1200 ? 1200 : metadata.width,
    height: Math.round((metadata.width > 1200 ? 1200 : metadata.width) * metadata.height / metadata.width),
    createdAt: new Date().toISOString()
  };
}

// Enhanced function to sync shared note updates
async function syncSharedNoteUpdates(originalNoteInfo, updatedMetadata) {
  if (!originalNoteInfo.metadata.hasBeenShared && !updatedMetadata.shared) return;

  try {
    console.log('🔄 Syncing shared note updates:', {
      noteId: originalNoteInfo.noteId,
      hasBeenShared: originalNoteInfo.metadata.hasBeenShared,
      updatedAt: updatedMetadata.updatedAt
    });

    const sharesFile = path.join(__dirname, '../data/shares.json');
    const shares = await fs.readJson(sharesFile).catch(() => ({}));
    
    const shareKey = `${originalNoteInfo.ownerId}-${originalNoteInfo.noteId}`;
    const shareInfo = shares[shareKey];
    
    if (!shareInfo || !shareInfo.participants) {
      console.log('🔍 No share info found for:', shareKey);
      return;
    }

    console.log('👥 Found participants to sync:', Object.keys(shareInfo.participants));
    
    // Update each participant's metadata
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
          participantMetadata[participantNoteId] = {
            ...participantMetadata[participantNoteId],
            title: updatedMetadata.title,
            updatedAt: updatedMetadata.updatedAt,
            lastEditedBy: updatedMetadata.lastEditedBy,
            lastEditorName: updatedMetadata.lastEditorName,
            lastEditorAvatar: updatedMetadata.lastEditorAvatar
          };
          
          await fs.writeJson(participantMetadataFile, participantMetadata);
          console.log(`✅ Synced note update to participant ${participantId} (note ${participantNoteId})`);
        } else {
          console.log(`❌ Could not find note ${originalNoteInfo.noteId} in participant ${participantId}'s metadata`);
        }
        
      } catch (error) {
        console.error(`❌ Failed to sync to participant ${participantId}:`, error);
      }
    }
    
  } catch (error) {
    console.error('❌ Error syncing shared note updates:', error);
  }
}

// ===== NEW ENHANCED COLLABORATION ENDPOINTS =====

router.post('/bulk-sync', collaborationLimiter, async (req, res) => {
  try {
    const { noteTimestamps } = req.body; // { noteId: timestamp, ... }
    const userId = req.user.id;
    
    if (!noteTimestamps || typeof noteTimestamps !== 'object') {
      return res.status(400).json({ error: 'Invalid noteTimestamps format' });
    }
    
    console.log(`🔄 Bulk sync requested for ${Object.keys(noteTimestamps).length} notes from ${req.isMobile ? 'mobile' : 'desktop'} device`);
    
    const results = {
      updates: {},
      errors: {},
      statistics: {
        checked: 0,
        updated: 0,
        errors: 0,
        skipped: 0
      }
    };
    
    // Process notes in batches to avoid overwhelming the system
    const noteIds = Object.keys(noteTimestamps);
    const batchSize = req.isMobile ? 8 : 10; // Smaller batches for mobile
    
    for (let i = 0; i < noteIds.length; i += batchSize) {
      const batch = noteIds.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (noteId) => {
        try {
          results.statistics.checked++;
          
          const since = noteTimestamps[noteId];
          if (!since) {
            results.statistics.skipped++;
            return;
          }
          
          // Check if user has access to this note
          if (!await checkNoteAccess(userId, noteId)) {
            results.errors[noteId] = 'Access denied';
            results.statistics.errors++;
            return;
          }
          
          // Find the original note info (handles shared notes)
          const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
          if (!originalNoteInfo) {
            results.errors[noteId] = 'Note not found';
            results.statistics.errors++;
            return;
          }
          
          if (!await fs.pathExists(originalNoteInfo.noteFile)) {
            results.errors[noteId] = 'Note file not found';
            results.statistics.errors++;
            return;
          }
          
          // Check if note was modified after the since timestamp
          const sinceDate = new Date(since);
          const updatedAt = new Date(originalNoteInfo.metadata.updatedAt);
          
          if (updatedAt > sinceDate) {
            // Note has updates
            const realPath = await resolveNotePath(originalNoteInfo.noteFile);
            const content = await fs.readFile(realPath, 'utf8');
            
            const lastEditor = originalNoteInfo.metadata.lastEditedBy ? {
              id: originalNoteInfo.metadata.lastEditedBy,
              name: originalNoteInfo.metadata.lastEditorName,
              avatar: originalNoteInfo.metadata.lastEditorAvatar
            } : null;
            
            results.updates[noteId] = {
              content,
              title: originalNoteInfo.metadata.title,
              updatedAt: originalNoteInfo.metadata.updatedAt,
              lastEditor,
              noteId
            };
            
            results.statistics.updated++;
            
            console.log(`📝 Note ${noteId} has updates`);
          }
          
        } catch (error) {
          console.error(`❌ Error checking note ${noteId}:`, error);
          results.errors[noteId] = error.message;
          results.statistics.errors++;
        }
      });
      
      await Promise.all(batchPromises);
      
      // Longer delay between batches for mobile to avoid overwhelming connections
      if (i + batchSize < noteIds.length) {
        await new Promise(resolve => setTimeout(resolve, req.isMobile ? 100 : 50));
      }
    }
    
    console.log('✅ Bulk sync complete:', results.statistics);
    
    res.json(results);
    
  } catch (error) {
    console.error('❌ Bulk sync failed:', error);
    res.status(500).json({ error: 'Bulk sync failed' });
  }
});

// Get note metadata only (for quick staleness checks)
router.get('/metadata', async (req, res) => {
  try {
    const userId = req.user.id;
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    await fs.ensureDir(userNotesDir);
    
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    
    const noteMetadata = {};
    
    for (const [id, meta] of Object.entries(metadata)) {
      const noteFile = path.join(userNotesDir, `${id}.md`);
      if (await fs.pathExists(noteFile)) {
        noteMetadata[id] = {
          id,
          title: meta.title,
          updatedAt: meta.updatedAt,
          createdAt: meta.createdAt,
          shared: meta.shared || false,
          sharedBy: meta.sharedBy || null,
          hasBeenShared: meta.hasBeenShared || false,
          permission: meta.permission || 'edit',
          lastEditedBy: meta.lastEditedBy,
          lastEditorName: meta.lastEditorName,
          lastEditorAvatar: meta.lastEditorAvatar
        };
      }
    }
    
    console.log(`📊 Returning metadata for ${Object.keys(noteMetadata).length} notes`);
    res.json(noteMetadata);
  } catch (error) {
    console.error('Error fetching note metadata:', error);
    res.status(500).json({ error: 'Failed to fetch note metadata' });
  }
});

// Enhanced presence heartbeat endpoint with mobile optimizations
router.post('/:noteId/heartbeat', collaborationLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user.id;
    
    // Check if user has access to this note
    if (!await checkNoteAccess(userId, noteId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Find the original note info
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    if (!originalNoteInfo) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    // Update presence timestamp and set mobile status
    const presenceNoteId = originalNoteInfo.noteId;
    await collaborationManager.updateEditorLastSeen(presenceNoteId, userId);
    
    // Set mobile presence if this is a mobile device
    if (req.isMobile) {
      await collaborationManager.setMobilePresence(presenceNoteId, userId, true);
    }
    
    // Return current note timestamp and sync recommendations
    const syncRecommendations = await collaborationManager.getSyncRecommendations(presenceNoteId);
    
    res.json({ 
      success: true,
      noteUpdatedAt: originalNoteInfo.metadata.updatedAt,
      serverTime: new Date().toISOString(),
      syncRecommendations,
      isMobile: req.isMobile
    });
    
  } catch (error) {
    console.error('Error updating heartbeat:', error);
    res.status(500).json({ error: 'Failed to update heartbeat' });
  }
});

// Enhanced updates endpoint with conflict detection
router.get('/:noteId/updates', collaborationLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const { since, localContentHash } = req.query;
    const userId = req.user.id;
    
    console.log('🔍 Updates endpoint called:', {
      noteId,
      userId,
      since,
      sinceType: typeof since,
      hasLocalHash: !!localContentHash,
      isMobile: req.isMobile
    });
    
    // Check if user has access to this note
    if (!await checkNoteAccess(userId, noteId)) {
      console.log('❌ Access denied for user:', userId);
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Find the original note info (handles shared notes)
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    if (!originalNoteInfo) {
      console.log('❌ Note not found:', noteId);
      return res.status(404).json({ error: 'Note not found' });
    }
    
    console.log('📊 Original note info:', {
      isShared: originalNoteInfo.isShared,
      ownerId: originalNoteInfo.ownerId,
      originalNoteId: originalNoteInfo.noteId,
      metadataUpdatedAt: originalNoteInfo.metadata.updatedAt,
      metadataTitle: originalNoteInfo.metadata.title,
      lastEditedBy: originalNoteInfo.metadata.lastEditedBy,
      lastEditorName: originalNoteInfo.metadata.lastEditorName
    });
    
    if (!await fs.pathExists(originalNoteInfo.noteFile)) {
      console.log('❌ Note file not found:', originalNoteInfo.noteFile);
      return res.status(404).json({ error: 'Note file not found' });
    }
    
    // Parse since timestamp
    const sinceDate = since ? new Date(since) : new Date(0);
    const updatedAt = new Date(originalNoteInfo.metadata.updatedAt);
    
    console.log('🕐 Timestamp comparison:', {
      since,
      sinceDate: sinceDate.toISOString(),
      sinceTimestamp: sinceDate.getTime(),
      noteUpdatedAt: originalNoteInfo.metadata.updatedAt,
      noteUpdatedAtDate: updatedAt.toISOString(),
      noteTimestamp: updatedAt.getTime(),
      difference: updatedAt.getTime() - sinceDate.getTime(),
      isNewer: updatedAt > sinceDate
    });
    
    // Return updates if note was modified after the since timestamp
    if (updatedAt > sinceDate) {
      console.log('✅ Note has updates, returning content');
      
      const realPath = await resolveNotePath(originalNoteInfo.noteFile);
      const content = await fs.readFile(realPath, 'utf8');
      
      // Enhanced conflict detection using content hash
      let hasConflict = false;
      if (localContentHash && content) {
        const serverContentHash = crypto.createHash('md5').update(content).digest('hex');
        hasConflict = serverContentHash !== localContentHash;
        
        console.log('🔍 Conflict detection:', {
          localHash: localContentHash.substring(0, 8) + '...',
          serverHash: serverContentHash.substring(0, 8) + '...',
          hasConflict
        });
      }
      
      // Get the last editor info
      const lastEditor = originalNoteInfo.metadata.lastEditedBy ? {
        id: originalNoteInfo.metadata.lastEditedBy,
        name: originalNoteInfo.metadata.lastEditorName,
        avatar: originalNoteInfo.metadata.lastEditorAvatar
      } : null;
      
      console.log('📤 Returning updates:', {
        hasContent: !!content,
        contentLength: content ? content.length : 0,
        title: originalNoteInfo.metadata.title,
        updatedAt: originalNoteInfo.metadata.updatedAt,
        lastEditor: lastEditor ? lastEditor.name : 'Unknown',
        hasConflict
      });
      
      return res.json({
        content,
        title: originalNoteInfo.metadata.title,
        updatedAt: originalNoteInfo.metadata.updatedAt,
        lastEditor,
        hasConflict,
        conflictInfo: hasConflict ? {
          message: 'Local and remote changes detected',
          lastEditor: lastEditor?.name || 'Unknown user',
          recommendation: 'merge'
        } : null
      });
    }
    
    console.log('⭐ No updates found, returning timestamp only');
    
    // No updates
    res.json({ 
      updatedAt: originalNoteInfo.metadata.updatedAt,
      hasConflict: false,
      debug: {
        since,
        noteUpdatedAt: originalNoteInfo.metadata.updatedAt,
        comparison: `${updatedAt.getTime()} <= ${sinceDate.getTime()}`,
        difference: updatedAt.getTime() - sinceDate.getTime()
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting note updates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enhanced: Register/unregister as active editor (Redis-backed with mobile support)
router.post('/:noteId/presence', collaborationLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const { action, editorInfo } = req.body;
    const userId = req.user.id;
    
    console.log('👋 Presence POST request:', { noteId, action, userId });
    
    // Check if user has access to this note
    if (!await checkNoteAccess(userId, noteId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Find the original note info to use consistent noteId for presence tracking
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    if (!originalNoteInfo) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    // Use the original note ID for presence tracking
    const presenceNoteId = originalNoteInfo.noteId;
    
    // Safely handle collaboration operations
    if (action === 'join') {
      const success = await safeCollaborationOperation(async () => {
        return await collaborationManager.addActiveEditor(presenceNoteId, userId, {
          ...editorInfo,
          name: editorInfo.name || req.user.name,
          avatar: editorInfo.avatar || req.user.avatar
        });
      }, true); // fallback to success
      
      console.log(`✅ User ${userId} ${success ? 'joined' : 'attempted to join'} editing note ${presenceNoteId}`);
      
    } else if (action === 'leave') {
      const success = await safeCollaborationOperation(async () => {
        return await collaborationManager.removeActiveEditor(presenceNoteId, userId);
      }, true); // fallback to success
      
      console.log(`✅ User ${userId} ${success ? 'left' : 'attempted to leave'} editing note ${presenceNoteId}`);
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Error managing presence:', error);
    // Return success anyway to prevent blocking the main app functionality
    res.json({ success: true, warning: 'Presence tracking unavailable' });
  }
});

// Enhanced: Get list of active editors for a note (Redis-backed with mobile info)
router.get('/:noteId/presence', collaborationLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user.id;
    
    console.log('👥 Presence GET request:', { noteId, userId });
    
    // Check if user has access to this note
    if (!await checkNoteAccess(userId, noteId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Find the original note info to use consistent noteId for presence tracking
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    if (!originalNoteInfo) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    // Use the original note ID for presence tracking
    const presenceNoteId = originalNoteInfo.noteId;
    
    // Safely get active editors with fallback
    const activeEditorsList = await safeCollaborationOperation(async () => {
      return await collaborationManager.getActiveEditors(presenceNoteId);
    }, []); // fallback to empty array
    
    console.log(`👥 Active editors for note ${presenceNoteId}:`, activeEditorsList.length);
    
    res.json({ activeEditors: activeEditorsList });
    
  } catch (error) {
    console.error('❌ Error getting active editors:', error);
    // Return empty list to prevent blocking the app
    res.json({ activeEditors: [] });
  }
});

// ===== EXISTING ENDPOINTS (Enhanced) =====

// Upload image to note
router.post('/:id/images', upload.single('image'), async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.user.id;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    
    const hasEditPermission = await checkEditPermission(userId, noteId);
    if (!hasEditPermission) {
      return res.status(403).json({ error: 'No edit permission for this note' });
    }
    
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const noteFile = path.join(userNotesDir, `${noteId}.md`);
    if (!await fs.pathExists(noteFile)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    const imageInfo = await processAndSaveImage(
      req.file.buffer,
      userId,
      noteId,
      req.file.originalname
    );
    
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    if (!metadata[noteId]) {
      metadata[noteId] = {};
    }
    if (!metadata[noteId].images) {
      metadata[noteId].images = [];
    }
    metadata[noteId].images.push(imageInfo);
    metadata[noteId].updatedAt = new Date().toISOString();
    await fs.writeJson(metadataFile, metadata);
    
    res.json({
      id: imageInfo.id,
      url: `/api/notes/${noteId}/images/${imageInfo.id}`,
      width: imageInfo.width,
      height: imageInfo.height,
      size: imageInfo.size,
      originalName: imageInfo.originalName
    });
    
  } catch (error) {
    console.error('Error uploading image:', error);
    if (error.message === 'Only image files are allowed') {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to upload image' });
    }
  }
});

// Serve image file
router.get('/:noteId/images/:imageId', async (req, res) => {
  try {
    const { noteId, imageId } = req.params;
    const userId = req.user.id;
    
    if (!await checkNoteAccess(userId, noteId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];
    
    if (!noteMetadata || !noteMetadata.images) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const imageInfo = noteMetadata.images.find(img => img.id === imageId);
    if (!imageInfo) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const imagePath = path.join(getImageDir(userId, noteId), imageInfo.filename);
    if (!await fs.pathExists(imagePath)) {
      return res.status(404).json({ error: 'Image file not found' });
    }
    
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    
    const imageStream = fs.createReadStream(imagePath);
    imageStream.pipe(res);
    
  } catch (error) {
    console.error('Error serving image:', error);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

// Delete image from note
router.delete('/:noteId/images/:imageId', async (req, res) => {
  try {
    const { noteId, imageId } = req.params;
    const userId = req.user.id;
    
    const hasEditPermission = await checkEditPermission(userId, noteId);
    if (!hasEditPermission) {
      return res.status(403).json({ error: 'No edit permission for this note' });
    }
    
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];
    
    if (!noteMetadata || !noteMetadata.images) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const imageIndex = noteMetadata.images.findIndex(img => img.id === imageId);
    if (imageIndex === -1) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const imageInfo = noteMetadata.images[imageIndex];
    
    const imagePath = path.join(getImageDir(userId, noteId), imageInfo.filename);
    await fs.remove(imagePath).catch(() => {});
    
    noteMetadata.images.splice(imageIndex, 1);
    noteMetadata.updatedAt = new Date().toISOString();
    await fs.writeJson(metadataFile, metadata);
    
    res.json({ message: 'Image deleted successfully' });
    
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Get all notes for user
router.get('/', async (req, res) => {
  try {
    const userNotesDir = path.join(__dirname, '../data/notes', req.user.id);
    await fs.ensureDir(userNotesDir);
    
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    
    const notes = [];
    for (const [id, meta] of Object.entries(metadata)) {
      const noteFile = path.join(userNotesDir, `${id}.md`);
      if (await fs.pathExists(noteFile)) {
        const realPath = await resolveNotePath(noteFile);
        const content = await fs.readFile(realPath, 'utf8');
        
        const lockStatus = await fileLockManager.checkLock(id);
        
        notes.push({
          id,
          title: meta.title,
          content,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          shared: meta.shared || false,
          sharedBy: meta.sharedBy || null,
          hasBeenShared: meta.hasBeenShared || false,
          sharedWith: meta.sharedWith || [],
          permission: meta.permission || 'edit',
          locked: lockStatus.locked,
          lockedBy: lockStatus.userId,
          lockedUntil: lockStatus.expiresAt,
          images: meta.images || [],
          lastEditedBy: meta.lastEditedBy,
          lastEditorName: meta.lastEditorName,
          lastEditorAvatar: meta.lastEditorAvatar
        });
      }
    }
    
    notes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    console.log(`📋 Returning ${notes.length} notes for user ${req.user.id}`);
    res.json(notes);
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Get specific note
router.get('/:id', async (req, res) => {
  try {
    const userNotesDir = path.join(__dirname, '../data/notes', req.user.id);
    const noteFile = path.join(userNotesDir, `${req.params.id}.md`);
    
    if (!await fs.pathExists(noteFile)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    const realPath = await resolveNotePath(noteFile);
    const content = await fs.readFile(realPath, 'utf8');
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const meta = metadata[req.params.id] || {};
    
    const lockStatus = await fileLockManager.checkLock(req.params.id);
    
    res.json({
      id: req.params.id,
      title: meta.title || 'Untitled',
      content,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      shared: meta.shared || false,
      sharedBy: meta.sharedBy || null,
      hasBeenShared: meta.hasBeenShared || false,
      sharedWith: meta.sharedWith || [],
      permission: meta.permission || 'edit',
      locked: lockStatus.locked,
      lockedBy: lockStatus.userId,
      lockedUntil: lockStatus.expiresAt,
      images: meta.images || [],
      lastEditedBy: meta.lastEditedBy,
      lastEditorName: meta.lastEditorName,
      lastEditorAvatar: meta.lastEditorAvatar
    });
  } catch (error) {
    console.error('Error fetching note:', error);
    res.status(500).json({ error: 'Failed to fetch note' });
  }
});

// Acquire lock for editing
router.post('/:id/lock', async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.user.id;
    
    const hasEditPermission = await checkEditPermission(userId, noteId);
    if (!hasEditPermission) {
      return res.status(403).json({ error: 'No edit permission for this note' });
    }
    
    const result = await fileLockManager.acquireLock(noteId, userId);
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Lock acquired',
        expiresAt: result.lockInfo.timestamp + result.lockInfo.timeout
      });
    } else {
      res.status(409).json(result);
    }
  } catch (error) {
    console.error('Error acquiring lock:', error);
    res.status(500).json({ error: 'Failed to acquire lock' });
  }
});

// Release lock
router.delete('/:id/lock', async (req, res) => {
  try {
    const result = await fileLockManager.releaseLock(req.params.id, req.user.id);
    res.json(result);
  } catch (error) {
    console.error('Error releasing lock:', error);
    res.status(500).json({ error: 'Failed to release lock' });
  }
});

// Extend lock
router.put('/:id/lock', async (req, res) => {
  try {
    const result = await fileLockManager.extendLock(req.params.id, req.user.id);
    
    if (result.success) {
      res.json({
        success: true,
        expiresAt: result.lockInfo.timestamp + result.lockInfo.timeout
      });
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error extending lock:', error);
    res.status(500).json({ error: 'Failed to extend lock' });
  }
});

// Create new note
router.post('/', async (req, res) => {
  try {
    const { title = 'Untitled', content = '' } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    
    const userNotesDir = path.join(__dirname, '../data/notes', req.user.id);
    await fs.ensureDir(userNotesDir);
    
    const noteFile = path.join(userNotesDir, `${id}.md`);
    await fs.writeFile(noteFile, content);
    
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    metadata[id] = {
      title,
      createdAt: now,
      updatedAt: now,
      images: [],
      lastEditedBy: req.user.id,
      lastEditorName: req.user.name,
      lastEditorAvatar: req.user.avatar
    };
    await fs.writeJson(metadataFile, metadata);
    
    console.log(`📝 Created new note ${id} for user ${req.user.id}`);
    
    res.json({
      id,
      title,
      content,
      createdAt: now,
      updatedAt: now,
      shared: false,
      permission: 'edit',
      images: [],
      lastEditedBy: req.user.id,
      lastEditorName: req.user.name,
      lastEditorAvatar: req.user.avatar
    });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Enhanced: Update note (with shared notes sync and improved presence tracking)
// Enhanced: Update note (with shared notes sync and improved presence tracking)
router.put('/:id', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { title, content } = req.body;
    const noteId = req.params.id;
    const userId = req.user.id;
    const now = new Date().toISOString();
    
    console.log('🚀 PUT /api/notes/:id started:', {
      noteId,
      userId,
      hasTitle: title !== undefined,
      hasContent: content !== undefined,
      timestamp: now
    });
    
    console.log('⏱️ Request setup completed:', Date.now() - startTime + 'ms');
    
    const hasEditPermission = await checkEditPermission(userId, noteId);
    console.log('⏱️ Edit permission check completed:', Date.now() - startTime + 'ms');
    
    if (!hasEditPermission) {
      console.log('❌ Edit permission denied for user:', userId);
      return res.status(403).json({ error: 'No edit permission for this note' });
    }
    
    const lockStatus = await fileLockManager.checkLock(noteId);
    console.log('⏱️ Lock check completed:', Date.now() - startTime + 'ms');
    
    if (lockStatus.locked && lockStatus.userId !== userId) {
      console.log('❌ Note is locked by another user:', lockStatus.userId);
      return res.status(423).json({ 
        error: 'Note is locked by another user',
        lockedBy: lockStatus.userId,
        lockedUntil: lockStatus.expiresAt
      });
    }
    
    // Find the original note info (handles shared notes)
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    console.log('⏱️ Original note info found:', Date.now() - startTime + 'ms');
    
    if (!originalNoteInfo) {
      console.log('❌ Note not found:', noteId);
      return res.status(404).json({ error: 'Note not found' });
    }
    
    console.log('📝 Original note info found:', {
      isShared: originalNoteInfo.isShared,
      ownerId: originalNoteInfo.ownerId,
      noteId: originalNoteInfo.noteId,
      currentUpdatedAt: originalNoteInfo.metadata.updatedAt
    });
    
    if (!await fs.pathExists(originalNoteInfo.noteFile)) {
      console.log('❌ Note file not found:', originalNoteInfo.noteFile);
      return res.status(404).json({ error: 'Note file not found' });
    }
    
    console.log('⏱️ File existence check completed:', Date.now() - startTime + 'ms');
    
    // Update note content in the original file
    if (content !== undefined) {
      const realPath = await resolveNotePath(originalNoteInfo.noteFile);
      await fs.writeFile(realPath, content);
      console.log('📄 Updated note content');
    }
    
    console.log('⏱️ File write completed:', Date.now() - startTime + 'ms');
    
    // Update metadata in the original location
    const updatedMetadata = {
      ...originalNoteInfo.metadata,
      updatedAt: now,
      lastEditedBy: req.user.id,
      lastEditorName: req.user.name,
      lastEditorAvatar: req.user.avatar
    };
    
    if (title !== undefined) {
      updatedMetadata.title = title;
    }
    
    console.log('📊 Updated metadata:', {
      title: updatedMetadata.title,
      updatedAt: updatedMetadata.updatedAt,
      lastEditorName: updatedMetadata.lastEditorName
    });
    
    // Update the allMetadata object and write the entire metadata file
    originalNoteInfo.allMetadata[originalNoteInfo.noteId] = updatedMetadata;
    await fs.writeJson(originalNoteInfo.metadataFile, originalNoteInfo.allMetadata);
    
    console.log('💾 Wrote metadata to:', originalNoteInfo.metadataFile);
    console.log('⏱️ Metadata write completed:', Date.now() - startTime + 'ms');
    
    // Enhanced: Sync updates to all shared copies
    await syncSharedNoteUpdates(originalNoteInfo, updatedMetadata);
    console.log('⏱️ Shared notes sync completed:', Date.now() - startTime + 'ms');
    
    // Update presence timestamp for this editor using Redis-backed manager
    const presenceNoteId = originalNoteInfo.noteId;
    try {
      await collaborationManager.updateEditorLastSeen(presenceNoteId, userId);
      console.log('⏱️ Collaboration manager update completed:', Date.now() - startTime + 'ms');
    } catch (collaborationError) {
      console.log('⚠️ Collaboration manager update failed (continuing anyway):', collaborationError.message);
      console.log('⏱️ Collaboration manager error handled:', Date.now() - startTime + 'ms');
    }
    
    // Extend lock if user has it
    if (lockStatus.locked && lockStatus.userId === userId) {
      await fileLockManager.extendLock(noteId, userId);
      console.log('⏱️ Lock extension completed:', Date.now() - startTime + 'ms');
    }
    
    // Return updated note data
    const responseContent = content !== undefined ? content : await fs.readFile(await resolveNotePath(originalNoteInfo.noteFile), 'utf8');
    
    console.log('⏱️ Response content prepared:', Date.now() - startTime + 'ms');
    console.log('✅ Note update complete, returning response');
    
    const totalTime = Date.now() - startTime;
    console.log('🏁 PUT /api/notes/:id completed in:', totalTime + 'ms');
    
    res.json({
      id: noteId,
      title: updatedMetadata.title,
      content: responseContent,
      createdAt: updatedMetadata.createdAt,
      updatedAt: now,
      shared: updatedMetadata.shared || false,
      permission: updatedMetadata.permission || 'edit',
      images: updatedMetadata.images || [],
      lastEditedBy: updatedMetadata.lastEditedBy,
      lastEditorName: updatedMetadata.lastEditorName,
      lastEditorAvatar: updatedMetadata.lastEditorAvatar
    });
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error('❌ Error updating note after', totalTime + 'ms:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to update note' });
  }
});
// STOP

// Delete note
router.delete('/:id', async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.user.id;
    
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const noteFile = path.join(userNotesDir, `${noteId}.md`);
    
    if (!await fs.pathExists(noteFile)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];
    
    // Clean up images directory
    const imageDir = getImageDir(userId, noteId);
    await fs.remove(imageDir).catch(() => {});
    
    // Clean up presence data for original note using Redis-backed manager
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    if (originalNoteInfo) {
      await collaborationManager.removeActiveEditor(originalNoteInfo.noteId, userId);
    }
    
    if (noteMetadata && noteMetadata.shared && noteMetadata.sharedBy) {
      await fs.remove(noteFile);
      delete metadata[noteId];
      await fs.writeJson(metadataFile, metadata);
    } else {
      await fs.remove(noteFile);
      delete metadata[noteId];
      await fs.writeJson(metadataFile, metadata);
    }
    
    await fileLockManager.releaseLock(noteId, userId);
    
    console.log(`🗑️ Deleted note ${noteId} for user ${userId}`);
    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Health check endpoint for monitoring
router.get('/health/status', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    redis: collaborationManager ? 'available' : 'unavailable',
    mobile: req.isMobile || false
  });
});

async function testCollaborationManager() {
  try {
    if (!collaborationManager) {
      console.warn('⚠️ collaborationManager is not defined');
      return false;
    }
    
    // Test basic functionality
    await collaborationManager.getActiveEditors('test');
    console.log('✅ collaborationManager is working');
    return true;
  } catch (error) {
    console.error('❌ collaborationManager test failed:', error.message);
    return false;
  }
}

// ADD this at the bottom of your file to test on startup:
testCollaborationManager();

module.exports = router;
