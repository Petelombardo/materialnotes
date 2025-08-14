const express = require('express');
const passport = require('passport');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const sharp = require('sharp');
const fileLockManager = require('../utils/fileLock');
const collaborationManager = require('../utils/collaborationManager');
const router = express.Router();

// REMOVED: In-memory store - now using Redis-backed collaborationManager
// const activeEditors = new Map(); // ❌ REMOVED

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

// Enhanced rate limiting for collaboration endpoints
const rateLimit = require('express-rate-limit');
const collaborationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Reduced from unlimited to 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.user?.id || req.ip}:${req.params.noteId || 'unknown'}`,
  message: {
    error: 'Too many collaboration requests, please slow down.',
    retryAfter: 60
  },
  skip: (req) => {
    // Skip rate limiting for simple GET requests
    return req.method === 'GET' && !req.path.includes('/updates') && !req.path.includes('/presence');
  }
});

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

// Helper function to find the original note file and metadata for shared notes
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

// Function to sync shared note updates
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

// ===== ENHANCED COLLABORATION ENDPOINTS WITH REDIS =====

// Enhanced: Get note updates since a specific timestamp (with better rate limiting)
router.get('/:noteId/updates', collaborationLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const { since } = req.query;
    const userId = req.user.id;
    
    console.log('🔍 Updates endpoint called:', {
      noteId,
      userId,
      since,
      sinceType: typeof since
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
        lastEditor: lastEditor ? lastEditor.name : 'Unknown'
      });
      
      return res.json({
        content,
        title: originalNoteInfo.metadata.title,
        updatedAt: originalNoteInfo.metadata.updatedAt,
        lastEditor
      });
    }
    
    console.log('⭐ No updates found, returning timestamp only');
    
    // No updates
    res.json({ 
      updatedAt: originalNoteInfo.metadata.updatedAt,
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

// Enhanced: Register/unregister as active editor (Redis-backed)
router.post('/:noteId/presence', collaborationLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const { action, editorInfo } = req.body;
    const userId = req.user.id;
    
    // Check if user has access to this note
    if (!await checkNoteAccess(userId, noteId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Find the original note info to use consistent noteId for presence tracking
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    if (!originalNoteInfo) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    // Use the original note ID for presence tracking so all users see the same presence
    const presenceNoteId = originalNoteInfo.noteId;
    
    if (action === 'join') {
      // Add editor using Redis-backed collaboration manager
      await collaborationManager.addActiveEditor(presenceNoteId, userId, {
        ...editorInfo,
        name: editorInfo.name || req.user.name,
        avatar: editorInfo.avatar || req.user.avatar
      });
      
      console.log(`User ${userId} joined editing note ${presenceNoteId} (original: ${originalNoteInfo.isShared})`);
      
    } else if (action === 'leave') {
      // Remove editor using Redis-backed collaboration manager
      await collaborationManager.removeActiveEditor(presenceNoteId, userId);
      console.log(`User ${userId} left editing note ${presenceNoteId}`);
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error managing presence:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enhanced: Get list of active editors for a note (Redis-backed)
router.get('/:noteId/presence', collaborationLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user.id;
    
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
    
    // Get active editors using Redis-backed collaboration manager
    const activeEditorsList = await collaborationManager.getActiveEditors(presenceNoteId);
    
    res.json({ activeEditors: activeEditorsList });
    
  } catch (error) {
    console.error('Error getting active editors:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== EXISTING ENDPOINTS =====

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
router.put('/:id', async (req, res) => {
  try {
    const { title, content } = req.body;
    const noteId = req.params.id;
    const userId = req.user.id;
    const now = new Date().toISOString();
    
    console.log('📝 Updating note:', {
      noteId,
      userId,
      hasTitle: title !== undefined,
      hasContent: content !== undefined,
      timestamp: now
    });
    
    const hasEditPermission = await checkEditPermission(userId, noteId);
    if (!hasEditPermission) {
      return res.status(403).json({ error: 'No edit permission for this note' });
    }
    
    const lockStatus = await fileLockManager.checkLock(noteId);
    if (lockStatus.locked && lockStatus.userId !== userId) {
      return res.status(423).json({ 
        error: 'Note is locked by another user',
        lockedBy: lockStatus.userId,
        lockedUntil: lockStatus.expiresAt
      });
    }
    
    // Find the original note info (handles shared notes)
    const originalNoteInfo = await findOriginalNoteInfo(userId, noteId);
    if (!originalNoteInfo) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    console.log('📝 Original note info found:', {
      isShared: originalNoteInfo.isShared,
      ownerId: originalNoteInfo.ownerId,
      noteId: originalNoteInfo.noteId,
      currentUpdatedAt: originalNoteInfo.metadata.updatedAt
    });
    
    if (!await fs.pathExists(originalNoteInfo.noteFile)) {
      return res.status(404).json({ error: 'Note file not found' });
    }
    
    // Update note content in the original file
    if (content !== undefined) {
      const realPath = await resolveNotePath(originalNoteInfo.noteFile);
      await fs.writeFile(realPath, content);
      console.log('📄 Updated note content');
    }
    
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
    
    // Enhanced: Sync updates to all shared copies
    await syncSharedNoteUpdates(originalNoteInfo, updatedMetadata);
    
    // Update presence timestamp for this editor using Redis-backed manager
    const presenceNoteId = originalNoteInfo.noteId;
    await collaborationManager.updateEditorLastSeen(presenceNoteId, userId);
    
    // Extend lock if user has it
    if (lockStatus.locked && lockStatus.userId === userId) {
      await fileLockManager.extendLock(noteId, userId);
    }
    
    // Return updated note data
    const responseContent = content !== undefined ? content : await fs.readFile(await resolveNotePath(originalNoteInfo.noteFile), 'utf8');
    
    console.log('✅ Note update complete, returning response');
    
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
    console.error('❌ Error updating note:', error);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

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
    
    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// REMOVED: Enhanced cleanup task - now handled by collaborationManager
// setInterval() - ❌ REMOVED (Redis handles TTL and cleanup)

module.exports = router;