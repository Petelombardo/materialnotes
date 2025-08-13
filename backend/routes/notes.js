const express = require('express');
const passport = require('passport');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const sharp = require('sharp');
const fileLockManager = require('../utils/fileLock');
const router = express.Router();

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(), // Store in memory for processing
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Only allow image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Middleware to authenticate all note routes
router.use(passport.authenticate('jwt', { session: false }));

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

// Helper function to check if user has permission to edit note
async function checkEditPermission(userId, noteId) {
  try {
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];

    if (!noteMetadata) return false;
    
    // If it's a shared note, check permission
    if (noteMetadata.shared) {
      return noteMetadata.permission === 'edit';
    }
    
    // If it's own note, always allow edit
    return true;
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
  
  // Get file extension from original name or default to jpg
  const ext = path.extname(originalName).toLowerCase() || '.jpg';
  const filename = `${imageId}${ext}`;
  const filepath = path.join(imageDir, filename);
  
  // Process image with sharp (resize if too large, compress)
  let processedBuffer;
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  
  // Resize if width > 1200px (maintain aspect ratio)
  if (metadata.width > 1200) {
    processedBuffer = await image
      .resize(1200, null, { withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } else {
    // Just compress
    processedBuffer = await image
      .jpeg({ quality: 85 })
      .toBuffer();
  }
  
  // Save processed image
  await fs.writeFile(filepath, processedBuffer);
  
  // Return image info
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

// Upload image to note
router.post('/:id/images', upload.single('image'), async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.user.id;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    
    // Check if user has edit permission
    const hasEditPermission = await checkEditPermission(userId, noteId);
    if (!hasEditPermission) {
      return res.status(403).json({ error: 'No edit permission for this note' });
    }
    
    // Check if note exists
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const noteFile = path.join(userNotesDir, `${noteId}.md`);
    if (!await fs.pathExists(noteFile)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    // Process and save image
    const imageInfo = await processAndSaveImage(
      req.file.buffer,
      userId,
      noteId,
      req.file.originalname
    );
    
    // Update note metadata with image info
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
    
    // Return image URL for frontend
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
    
    // Check if user has access to this note
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const noteFile = path.join(userNotesDir, `${noteId}.md`);
    if (!await fs.pathExists(noteFile)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    // Get image info from metadata
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
    
    // Serve the image file
    const imagePath = path.join(getImageDir(userId, noteId), imageInfo.filename);
    if (!await fs.pathExists(imagePath)) {
      return res.status(404).json({ error: 'Image file not found' });
    }
    
    // Set appropriate headers
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    
    // Stream the image
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
    
    // Check if user has edit permission
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
    
    // Delete physical file
    const imagePath = path.join(getImageDir(userId, noteId), imageInfo.filename);
    await fs.remove(imagePath).catch(() => {}); // Don't fail if file doesn't exist
    
    // Remove from metadata
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
        
        // Check lock status
        const lockStatus = await fileLockManager.checkLock(id);
        
        notes.push({
          id,
          title: meta.title,
          content,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          shared: meta.shared || false,
          sharedBy: meta.sharedBy || null,
          permission: meta.permission || 'edit',
          locked: lockStatus.locked,
          lockedBy: lockStatus.userId,
          lockedUntil: lockStatus.expiresAt,
          images: meta.images || [] // Include image metadata
        });
      }
    }
    
    // Sort by updatedAt descending
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
    
    // Check lock status
    const lockStatus = await fileLockManager.checkLock(req.params.id);
    
    res.json({
      id: req.params.id,
      title: meta.title || 'Untitled',
      content,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      shared: meta.shared || false,
      sharedBy: meta.sharedBy || null,
      permission: meta.permission || 'edit',
      locked: lockStatus.locked,
      lockedBy: lockStatus.userId,
      lockedUntil: lockStatus.expiresAt,
      images: meta.images || [] // Include image metadata
    });
  } catch (error) {
    console.error('Error fetching note:', error);
    res.status(500).json({ error: 'Failed to fetch note' });
  }
});

// [Rest of your existing routes remain the same - lock routes, create, update, delete]
// I'll include them below for completeness:

// Acquire lock for editing
router.post('/:id/lock', async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.user.id;
    
    // Check if user has edit permission
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
    
    // Save note content
    const noteFile = path.join(userNotesDir, `${id}.md`);
    await fs.writeFile(noteFile, content);
    
    // Update metadata
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    metadata[id] = {
      title,
      createdAt: now,
      updatedAt: now,
      images: [] // Initialize empty images array
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
      images: []
    });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Update note
router.put('/:id', async (req, res) => {
  try {
    const { title, content } = req.body;
    const noteId = req.params.id;
    const userId = req.user.id;
    const now = new Date().toISOString();
    
    // Check if user has edit permission
    const hasEditPermission = await checkEditPermission(userId, noteId);
    if (!hasEditPermission) {
      return res.status(403).json({ error: 'No edit permission for this note' });
    }
    
    // Check if note is locked by another user
    const lockStatus = await fileLockManager.checkLock(noteId);
    if (lockStatus.locked && lockStatus.userId !== userId) {
      return res.status(423).json({ 
        error: 'Note is locked by another user',
        lockedBy: lockStatus.userId,
        lockedUntil: lockStatus.expiresAt
      });
    }
    
    const userNotesDir = path.join(__dirname, '../data/notes', userId);
    const noteFile = path.join(userNotesDir, `${noteId}.md`);
    
    if (!await fs.pathExists(noteFile)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    // Update note content (resolve symlink if needed)
    if (content !== undefined) {
      const realPath = await resolveNotePath(noteFile);
      await fs.writeFile(realPath, content);
    }
    
    // Update metadata in user's folder
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    if (!metadata[noteId]) {
      metadata[noteId] = { createdAt: now, images: [] };
    }
    if (title !== undefined) {
      metadata[noteId].title = title;
    }
    metadata[noteId].updatedAt = now;
    await fs.writeJson(metadataFile, metadata);
    
    // If it's a shared note, also update shared metadata
    if (metadata[noteId].shared && metadata[noteId].sharedNoteId) {
      const sharedMetadataFile = path.join(__dirname, '../data/shared_notes/metadata.json');
      const sharedMetadata = await fs.readJson(sharedMetadataFile).catch(() => ({}));
      if (sharedMetadata[metadata[noteId].sharedNoteId]) {
        if (title !== undefined) {
          sharedMetadata[metadata[noteId].sharedNoteId].title = title;
        }
        sharedMetadata[metadata[noteId].sharedNoteId].updatedAt = now;
        await fs.writeJson(sharedMetadataFile, sharedMetadata);
      }
    }
    
    // Extend lock if user has it
    if (lockStatus.locked && lockStatus.userId === userId) {
      await fileLockManager.extendLock(noteId, userId);
    }
    
    res.json({
      id: noteId,
      title: metadata[noteId].title,
      content: content !== undefined ? content : await fs.readFile(await resolveNotePath(noteFile), 'utf8'),
      createdAt: metadata[noteId].createdAt,
      updatedAt: now,
      shared: metadata[noteId].shared || false,
      permission: metadata[noteId].permission || 'edit',
      images: metadata[noteId].images || []
    });
  } catch (error) {
    console.error('Error updating note:', error);
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
    
    // Get metadata to check if it's shared and clean up images
    const metadataFile = path.join(userNotesDir, 'metadata.json');
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];
    
    // Clean up images directory
    const imageDir = getImageDir(userId, noteId);
    await fs.remove(imageDir).catch(() => {}); // Don't fail if directory doesn't exist
    
    // If it's a shared note and user is not owner, just remove symlink
    if (noteMetadata && noteMetadata.shared && noteMetadata.sharedBy) {
      await fs.remove(noteFile);
      delete metadata[noteId];
      await fs.writeJson(metadataFile, metadata);
    } else {
      // If user is owner of shared note, need to handle differently
      // For now, just delete the file (could be enhanced to transfer ownership)
      await fs.remove(noteFile);
      delete metadata[noteId];
      await fs.writeJson(metadataFile, metadata);
    }
    
    // Release any locks
    await fileLockManager.releaseLock(noteId, userId);
    
    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

module.exports = router;