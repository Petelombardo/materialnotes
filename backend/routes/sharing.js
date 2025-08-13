const express = require('express');
const passport = require('passport');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// Middleware to authenticate all sharing routes
router.use(passport.authenticate('jwt', { session: false }));

// Share a note with another user
router.post('/share', async (req, res) => {
  try {
    const { noteId, targetUserEmail, permission = 'edit' } = req.body;
    const sharerUserId = req.user.id;

    // Validate permission level
    if (!['view', 'edit'].includes(permission)) {
      return res.status(400).json({ error: 'Invalid permission level' });
    }

    // Check if note exists and user owns it
    const sharerNotesDir = path.join(__dirname, '../data/notes', sharerUserId);
    const noteFile = path.join(sharerNotesDir, `${noteId}.md`);
    const metadataFile = path.join(sharerNotesDir, 'metadata.json');

    if (!await fs.pathExists(noteFile)) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Get note metadata
    const metadata = await fs.readJson(metadataFile).catch(() => ({}));
    const noteMetadata = metadata[noteId];
    if (!noteMetadata) {
      return res.status(404).json({ error: 'Note metadata not found' });
    }

    // Find target user
    const usersFile = path.join(__dirname, '../data/users.json');
    const users = await fs.readJson(usersFile).catch(() => ({}));
    const targetUser = Object.values(users).find(u => u.email === targetUserEmail);
    
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (targetUser.id === sharerUserId) {
      return res.status(400).json({ error: 'Cannot share note with yourself' });
    }

    // Create shared notes directory if it doesn't exist
    const sharedNotesDir = path.join(__dirname, '../data/shared_notes');
    await fs.ensureDir(sharedNotesDir);

    // Check if note is already shared
    const sharesFile = path.join(__dirname, '../data/shares.json');
    const shares = await fs.readJson(sharesFile).catch(() => ({}));
    
    const shareKey = `${sharerUserId}-${noteId}`;
    let shareInfo = shares[shareKey];

    if (!shareInfo) {
      // First time sharing this note - move it to shared location
      const sharedNoteId = uuidv4();
      const sharedNoteFile = path.join(sharedNotesDir, `${sharedNoteId}.md`);
      const sharedMetadataFile = path.join(sharedNotesDir, 'metadata.json');

      // Move note to shared location
      await fs.move(noteFile, sharedNoteFile);

      // Update shared metadata
      const sharedMetadata = await fs.readJson(sharedMetadataFile).catch(() => ({}));
      sharedMetadata[sharedNoteId] = {
        ...noteMetadata,
        originalNoteId: noteId,
        ownerId: sharerUserId,
        createdAt: noteMetadata.createdAt,
        sharedAt: new Date().toISOString()
      };
      await fs.writeJson(sharedMetadataFile, sharedMetadata);

      // Create symlink in sharer's directory
      const symlinkTarget = path.relative(sharerNotesDir, sharedNoteFile);
      await fs.symlink(symlinkTarget, noteFile);

      // Create share record
      shareInfo = {
        sharedNoteId,
        ownerId: sharerUserId,
        originalNoteId: noteId,
        createdAt: new Date().toISOString(),
        participants: {}
      };
      shares[shareKey] = shareInfo;
    }

    // Add participant
    shareInfo.participants[targetUser.id] = {
      email: targetUserEmail,
      permission,
      sharedAt: new Date().toISOString(),
      accepted: false
    };

    // Create symlink in target user's directory
    const targetNotesDir = path.join(__dirname, '../data/notes', targetUser.id);
    await fs.ensureDir(targetNotesDir);
    
    const sharedNoteFile = path.join(sharedNotesDir, `${shareInfo.sharedNoteId}.md`);
    const targetNoteFile = path.join(targetNotesDir, `${noteId}.md`);
    
    // Create symlink if it doesn't exist
    if (!await fs.pathExists(targetNoteFile)) {
      const symlinkTarget = path.relative(targetNotesDir, sharedNoteFile);
      await fs.symlink(symlinkTarget, targetNoteFile);
    }

    // Update target user's metadata
    const targetMetadataFile = path.join(targetNotesDir, 'metadata.json');
    const targetMetadata = await fs.readJson(targetMetadataFile).catch(() => ({}));
    targetMetadata[noteId] = {
      title: noteMetadata.title,
      createdAt: noteMetadata.createdAt,
      updatedAt: noteMetadata.updatedAt,
      shared: true,
      sharedBy: req.user.email,
      permission,
      originalNoteId: noteId,
      sharedNoteId: shareInfo.sharedNoteId
    };
    await fs.writeJson(targetMetadataFile, targetMetadata);

    // Save shares
    await fs.writeJson(sharesFile, shares);

    res.json({
      message: 'Note shared successfully',
      shareId: shareKey,
      sharedWith: targetUserEmail,
      permission
    });

  } catch (error) {
    console.error('Error sharing note:', error);
    res.status(500).json({ error: 'Failed to share note' });
  }
});

// Get shared notes for current user
router.get('/shared-with-me', async (req, res) => {
  try {
    const userId = req.user.id;
    const sharesFile = path.join(__dirname, '../data/shares.json');
    const shares = await fs.readJson(sharesFile).catch(() => ({}));

    const sharedWithMe = [];
    
    for (const [shareKey, shareInfo] of Object.entries(shares)) {
      if (shareInfo.participants[userId]) {
        const participant = shareInfo.participants[userId];
        sharedWithMe.push({
          shareKey,
          originalNoteId: shareInfo.originalNoteId,
          sharedNoteId: shareInfo.sharedNoteId,
          ownerId: shareInfo.ownerId,
          permission: participant.permission,
          sharedBy: participant.email,
          sharedAt: participant.sharedAt,
          accepted: participant.accepted
        });
      }
    }

    res.json(sharedWithMe);
  } catch (error) {
    console.error('Error getting shared notes:', error);
    res.status(500).json({ error: 'Failed to get shared notes' });
  }
});

// Get notes shared by current user
router.get('/shared-by-me', async (req, res) => {
  try {
    const userId = req.user.id;
    const sharesFile = path.join(__dirname, '../data/shares.json');
    const shares = await fs.readJson(sharesFile).catch(() => ({}));

    const sharedByMe = [];
    
    for (const [shareKey, shareInfo] of Object.entries(shares)) {
      if (shareInfo.ownerId === userId) {
        sharedByMe.push({
          shareKey,
          originalNoteId: shareInfo.originalNoteId,
          sharedNoteId: shareInfo.sharedNoteId,
          participants: shareInfo.participants,
          createdAt: shareInfo.createdAt
        });
      }
    }

    res.json(sharedByMe);
  } catch (error) {
    console.error('Error getting shared notes:', error);
    res.status(500).json({ error: 'Failed to get shared notes' });
  }
});

// Remove sharing (unshare a note)
router.delete('/unshare/:noteId/:targetUserId', async (req, res) => {
  try {
    const { noteId, targetUserId } = req.params;
    const ownerId = req.user.id;

    const sharesFile = path.join(__dirname, '../data/shares.json');
    const shares = await fs.readJson(sharesFile).catch(() => ({}));
    
    const shareKey = `${ownerId}-${noteId}`;
    const shareInfo = shares[shareKey];

    if (!shareInfo || shareInfo.ownerId !== ownerId) {
      return res.status(404).json({ error: 'Share not found or not authorized' });
    }

    // Remove participant
    delete shareInfo.participants[targetUserId];

    // Remove symlink from target user's directory
    const targetNotesDir = path.join(__dirname, '../data/notes', targetUserId);
    const targetNoteFile = path.join(targetNotesDir, `${noteId}.md`);
    
    if (await fs.pathExists(targetNoteFile)) {
      await fs.remove(targetNoteFile);
    }

    // Remove from target user's metadata
    const targetMetadataFile = path.join(targetNotesDir, 'metadata.json');
    const targetMetadata = await fs.readJson(targetMetadataFile).catch(() => ({}));
    delete targetMetadata[noteId];
    await fs.writeJson(targetMetadataFile, targetMetadata);

    // If no more participants, move note back to owner's directory
    if (Object.keys(shareInfo.participants).length === 0) {
      const ownerNotesDir = path.join(__dirname, '../data/notes', ownerId);
      const ownerNoteFile = path.join(ownerNotesDir, `${noteId}.md`);
      const sharedNoteFile = path.join(__dirname, '../data/shared_notes', `${shareInfo.sharedNoteId}.md`);

      // Remove symlink and restore original file
      if (await fs.pathExists(ownerNoteFile)) {
        await fs.remove(ownerNoteFile);
      }
      await fs.move(sharedNoteFile, ownerNoteFile);

      // Remove from shared metadata
      const sharedMetadataFile = path.join(__dirname, '../data/shared_notes', 'metadata.json');
      const sharedMetadata = await fs.readJson(sharedMetadataFile).catch(() => ({}));
      delete sharedMetadata[shareInfo.sharedNoteId];
      await fs.writeJson(sharedMetadataFile, sharedMetadata);

      // Remove share record
      delete shares[shareKey];
    }

    await fs.writeJson(sharesFile, shares);

    res.json({ message: 'Note unshared successfully' });

  } catch (error) {
    console.error('Error unsharing note:', error);
    res.status(500).json({ error: 'Failed to unshare note' });
  }
});

module.exports = router;