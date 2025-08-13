import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  IconButton
} from '@mui/material';
import {
  Share as ShareIcon,
  Delete as DeleteIcon,
  Email as EmailIcon,
  Lock as LockIcon,
  Edit as EditIcon,
  Visibility as ViewIcon
} from '@mui/icons-material';
import api from '../utils/api';

const ShareNoteDialog = ({ open, onClose, note, onNoteUpdated }) => {
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState('edit');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sharedWith, setSharedWith] = useState([]);

  // Load sharing info when dialog opens
  React.useEffect(() => {
    if (open && note) {
      loadSharingInfo();
    }
  }, [open, note]);

  const loadSharingInfo = async () => {
    try {
      const response = await api.get('/api/sharing/shared-by-me');
      const noteShares = response.data.find(share => share.originalNoteId === note.id);
      
      if (noteShares) {
        const participants = Object.entries(noteShares.participants || {}).map(([userId, info]) => ({
          userId,
          ...info
        }));
        setSharedWith(participants);
      } else {
        setSharedWith([]);
      }
    } catch (error) {
      console.error('Failed to load sharing info:', error);
    }
  };

  const handleShare = async () => {
    if (!email.trim()) {
      setError('Please enter an email address');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await api.post('/api/sharing/share', {
        noteId: note.id,
        targetUserEmail: email.trim(),
        permission
      });

      setSuccess(`Note shared with ${email} successfully!`);
      setEmail('');
      loadSharingInfo(); // Refresh the sharing list
      
      if (onNoteUpdated) {
        onNoteUpdated();
      }

    } catch (error) {
      setError(error.response?.data?.error || 'Failed to share note');
    } finally {
      setLoading(false);
    }
  };

  const handleUnshare = async (userId) => {
    setLoading(true);
    try {
      await api.delete(`/api/sharing/unshare/${note.id}/${userId}`);
      setSuccess('Note unshared successfully');
      loadSharingInfo(); // Refresh the sharing list
      
      if (onNoteUpdated) {
        onNoteUpdated();
      }
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to unshare note');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setEmail('');
    setError('');
    setSuccess('');
    setSharedWith([]);
    onClose();
  };

  if (!note) return null;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box display="flex" alignItems="center" gap={1}>
          <ShareIcon color="primary" />
          Share Note: {note.title || 'Untitled'}
        </Box>
      </DialogTitle>
      
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        
        {success && (
          <Alert severity="success" sx={{ mb: 2 }}>
            {success}
          </Alert>
        )}

        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            Share with new user
          </Typography>
          
          <TextField
            fullWidth
            label="Email address"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: <EmailIcon sx={{ mr: 1, color: 'text.secondary' }} />
            }}
          />

          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Permission</InputLabel>
            <Select
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
              label="Permission"
            >
              <MenuItem value="view">
                <Box display="flex" alignItems="center" gap={1}>
                  <ViewIcon fontSize="small" />
                  View only
                </Box>
              </MenuItem>
              <MenuItem value="edit">
                <Box display="flex" alignItems="center" gap={1}>
                  <EditIcon fontSize="small" />
                  Can edit
                </Box>
              </MenuItem>
            </Select>
          </FormControl>
        </Box>

        {sharedWith.length > 0 && (
          <Box>
            <Typography variant="h6" gutterBottom>
              Currently shared with
            </Typography>
            
            <List dense>
              {sharedWith.map((participant) => (
                <ListItem key={participant.userId} divider>
                  <ListItemText
                    primary={
                      <Box display="flex" alignItems="center" gap={1}>
                        <EmailIcon fontSize="small" color="action" />
                        {participant.email}
                      </Box>
                    }
                    secondary={
                      <Box display="flex" alignItems="center" gap={1} mt={0.5}>
                        <Chip
                          size="small"
                          icon={participant.permission === 'edit' ? <EditIcon /> : <ViewIcon />}
                          label={participant.permission === 'edit' ? 'Can edit' : 'View only'}
                          color={participant.permission === 'edit' ? 'primary' : 'default'}
                        />
                        <Typography variant="caption" color="text.secondary">
                          Shared {new Date(participant.sharedAt).toLocaleDateString()}
                        </Typography>
                      </Box>
                    }
                  />
                  <ListItemSecondaryAction>
                    <IconButton
                      edge="end"
                      onClick={() => handleUnshare(participant.userId)}
                      disabled={loading}
                      size="small"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </ListItemSecondaryAction>
                </ListItem>
              ))}
            </List>
          </Box>
        )}

        {note.shared && note.sharedBy && (
          <Alert severity="info" sx={{ mt: 2 }}>
            <Typography variant="body2">
              This note was shared with you by {note.sharedBy}
            </Typography>
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose}>
          Cancel
        </Button>
        <Button
          onClick={handleShare}
          variant="contained"
          disabled={loading || !email.trim()}
          startIcon={loading ? <CircularProgress size={20} /> : <ShareIcon />}
        >
          Share
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ShareNoteDialog;