import React, { useState, useMemo } from 'react';
import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
  Typography,
  Divider,
  Paper,
  TextField,
  InputAdornment,
  Chip,
  Tooltip,
  SwipeableDrawer,
  useTheme,
  Button
} from '@mui/material';
import { 
  Delete as DeleteIcon, 
  Note as NoteIcon, 
  Search as SearchIcon,
  Clear as ClearIcon,
  People as PeopleIcon,
  Lock as LockIcon,
  Visibility as VisibilityIcon,
  CloudOff as CloudOffIcon,
  MoreVert as MoreVertIcon,
  Add as AddIcon
} from '@mui/icons-material';

const NotesList = ({ notes, selectedNote, onSelectNote, onDeleteNote, onCreateNote, isMobile = false }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [swipeNote, setSwipeNote] = useState(null);
  const theme = useTheme();

  // Helper function to strip HTML tags
  const stripHtml = (html) => {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '');
  };

  // Filter notes based on search term
  const filteredNotes = useMemo(() => {
    if (!notes) return [];
    if (!searchTerm || !searchTerm.trim()) return notes;
    
    const search = searchTerm.toLowerCase().trim();
    
    return notes.filter(note => {
      if (!note) return false;
      
      // Search in title
      const title = (note.title || '').toLowerCase();
      if (title.includes(search)) return true;
      
      // Search in content (strip HTML first)
      const content = stripHtml(note.content || '').toLowerCase();
      if (content.includes(search)) return true;
      
      return false;
    });
  }, [notes, searchTerm]);

  const formatDate = (dateString) => {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diff = now - date;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));

      if (days === 0) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (days === 1) {
        return 'Yesterday';
      } else if (days < 7) {
        return days + ' days ago';
      } else {
        return date.toLocaleDateString();
      }
    } catch (error) {
      return 'Unknown date';
    }
  };

  const getPreview = (content) => {
    const text = stripHtml(content || '').replace(/\n/g, ' ').trim();
    const maxLength = isMobile ? 80 : 100;
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const clearSearch = () => {
    setSearchTerm('');
  };

  // Simple and reliable highlight function
  const highlightText = (text, search) => {
    if (!search || !search.trim() || !text) return text;
    
    const searchTerm = search.trim();
    const textStr = String(text);
    const lowerText = textStr.toLowerCase();
    const lowerSearch = searchTerm.toLowerCase();
    
    if (!lowerText.includes(lowerSearch)) return textStr;
    
    // Find all matches
    const parts = [];
    let remaining = textStr;
    let remainingLower = lowerText;
    let searchIndex;
    
    while ((searchIndex = remainingLower.indexOf(lowerSearch)) !== -1) {
      // Add text before match
      if (searchIndex > 0) {
        parts.push(remaining.substring(0, searchIndex));
      }
      
      // Add highlighted match
      const matchText = remaining.substring(searchIndex, searchIndex + searchTerm.length);
      parts.push(
        <span 
          key={parts.length} 
          style={{ backgroundColor: '#ffeb3b', fontWeight: 'bold' }}
        >
          {matchText}
        </span>
      );
      
      // Update remaining text
      remaining = remaining.substring(searchIndex + searchTerm.length);
      remainingLower = remainingLower.substring(searchIndex + searchTerm.length);
    }
    
    // Add any remaining text
    if (remaining) {
      parts.push(remaining);
    }
    
    return parts.length > 1 ? parts : textStr;
  };

  const getStatusIndicators = (note) => {
    const indicators = [];
    
    // Offline/Pending indicator
    if (note.offline || note.pendingSync) {
      indicators.push(
        <Tooltip 
          key="offline" 
          title={note.pendingSync ? "Changes pending sync" : "Available offline"}
        >
          <Chip
            icon={<CloudOffIcon />}
            label={note.pendingSync ? "Pending" : "Offline"}
            size="small"
            color={note.pendingSync ? "warning" : "info"}
            variant="outlined"
            sx={{ 
              mr: 0.5,
              '& .MuiChip-label': {
                fontSize: isMobile ? '0.7rem' : '0.75rem'
              }
            }}
          />
        </Tooltip>
      );
    }
    
    // Shared indicator
    if (note.shared) {
      indicators.push(
        <Tooltip 
          key="shared" 
          title={note.sharedBy ? `Shared by ${note.sharedBy}` : 'Shared note'}
        >
          <Chip
            icon={<PeopleIcon />}
            label="Shared"
            size="small"
            color="secondary"
            variant="outlined"
            sx={{ 
              mr: 0.5,
              '& .MuiChip-label': {
                fontSize: isMobile ? '0.7rem' : '0.75rem'
              }
            }}
          />
        </Tooltip>
      );
    }
    
    // Lock indicator
    if (note.locked) {
      indicators.push(
        <Tooltip 
          key="locked" 
          title={`Being edited by another user`}
        >
          <Chip
            icon={<LockIcon />}
            label="Locked"
            size="small"
            color="warning"
            variant="outlined"
            sx={{ 
              mr: 0.5,
              '& .MuiChip-label': {
                fontSize: isMobile ? '0.7rem' : '0.75rem'
              }
            }}
          />
        </Tooltip>
      );
    }
    
    // Read-only indicator
    if (note.permission === 'view') {
      indicators.push(
        <Tooltip key="readonly" title="View only">
          <Chip
            icon={<VisibilityIcon />}
            label="View only"
            size="small"
            color="default"
            variant="outlined"
            sx={{ 
              mr: 0.5,
              '& .MuiChip-label': {
                fontSize: isMobile ? '0.7rem' : '0.75rem'
              }
            }}
          />
        </Tooltip>
      );
    }
    
    return indicators;
  };

  const handleSwipeDelete = (note) => {
    setSwipeNote(null);
    onDeleteNote(note.id);
  };

  const renderNoteItem = (note, index) => (
    <React.Fragment key={note.id}>
      <ListItem
        disablePadding
        sx={{
          backgroundColor: selectedNote?.id === note.id ? 'action.selected' : 'transparent',
          width: '100%',
          maxWidth: '100%',
        }}
      >
        <ListItemButton
          onClick={() => onSelectNote(note)}
          sx={{ 
            py: isMobile ? 3 : 2.5,
            px: isMobile ? 2 : 2,
            width: '100%',
            maxWidth: '100%',
            overflow: 'hidden',
            minHeight: isMobile ? 80 : 'auto',
            '&:active': {
              backgroundColor: 'action.hover'
            }
          }}
        >
          <ListItemText
            sx={{
              width: '100%',
              maxWidth: '100%',
              overflow: 'hidden',
              minWidth: 0,
            }}
            primary={
              <Box sx={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
                <Typography
                  variant="subtitle1"
                  sx={{
                    fontWeight: selectedNote?.id === note.id ? 600 : 500,
                    mb: 0.5,
                    fontSize: isMobile ? '1.125rem' : '0.98rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}
                >
                  {highlightText(note.title || 'Untitled', searchTerm)}
                </Typography>
                
                {/* Status indicators */}
                <Box sx={{ 
                  mb: 0.5,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 0.5,
                  maxWidth: '100%',
                  overflow: 'hidden',
                }}>
                  {getStatusIndicators(note)}
                </Box>
              </Box>
            }
            secondary={
              <Box sx={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ 
                    mb: 0.5, 
                    lineHeight: 1.4, 
                    fontSize: isMobile ? '0.95rem' : '0.9rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: isMobile ? 2 : 2,
                    WebkitBoxOrient: 'vertical',
                    maxWidth: '100%',
                    wordBreak: 'break-word',
                  }}
                >
                  {highlightText(getPreview(note.content), searchTerm)}
                </Typography>
                <Typography 
                  variant="caption" 
                  color="text.disabled" 
                  sx={{ 
                    fontSize: isMobile ? '0.8rem' : '0.875rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}
                >
                  {formatDate(note.updatedAt)}
                </Typography>
              </Box>
            }
          />
          <IconButton
            edge="end"
            onClick={(e) => {
              e.stopPropagation();
              if (isMobile) {
                setSwipeNote(note);
              } else {
                onDeleteNote(note.id);
              }
            }}
            sx={{ 
              ml: 1, 
              flexShrink: 0,
              width: isMobile ? 48 : 40,
              height: isMobile ? 48 : 40,
              '&:active': {
                backgroundColor: 'action.hover'
              }
            }}
          >
            {isMobile ? <MoreVertIcon /> : <DeleteIcon />}
          </IconButton>
        </ListItemButton>
      </ListItem>
      {index < filteredNotes.length - 1 && <Divider />}
    </React.Fragment>
  );

  return (
    <>
      <Paper
        sx={{
          width: isMobile ? '100%' : 360,
          minWidth: isMobile ? '100%' : 360,
          maxWidth: isMobile ? '100%' : 360,
          borderRadius: isMobile ? 0 : 0,
          borderRight: isMobile ? 'none' : 1,
          borderColor: 'divider',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          overflow: 'hidden',
          height: '100%',
        }}
      >
        <Box sx={{ 
          p: isMobile ? 2 : 2, 
          borderBottom: 1, 
          borderColor: 'divider', 
          flexShrink: 0 
        }}>
          <Typography 
            variant="h6" 
            color="primary" 
            sx={{ 
              mb: 2,
              fontSize: isMobile ? '1.25rem' : '1.25rem'
            }}
          >
            Notes ({filteredNotes.length})
          </Typography>
          
          <TextField
            fullWidth
            variant="outlined"
            placeholder="Search notes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            size={isMobile ? "medium" : "small"}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
              endAdornment: searchTerm && (
                <InputAdornment position="end">
                  <IconButton 
                    onClick={clearSearch} 
                    edge="end" 
                    size="small"
                    sx={{
                      width: isMobile ? 40 : 32,
                      height: isMobile ? 40 : 32
                    }}
                  >
                    <ClearIcon />
                  </IconButton>
                </InputAdornment>
              ),
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                fontSize: isMobile ? '16px' : '1rem', // Prevent zoom on iOS
              },
              '& .MuiOutlinedInput-input': {
                padding: isMobile ? '14px 12px' : '8.5px 14px'
              },
              width: '100%',
              maxWidth: '100%',
            }}
          />
        </Box>

        {/* New Note Button - Always visible on desktop */}
        {!isMobile && (
          <Box sx={{ 
            p: 2, 
            pt: 0,
            borderBottom: 1, 
            borderColor: 'divider'
          }}>
            <Button
              fullWidth
              variant="contained"
              startIcon={<AddIcon />}
              onClick={onCreateNote}
              sx={{
                py: 1.5,
                fontSize: '1rem',
                fontWeight: 500,
                textTransform: 'none',
                borderRadius: 2,
                boxShadow: 1,
                '&:hover': {
                  boxShadow: 2
                }
              }}
            >
              New Note
            </Button>
          </Box>
        )}

        <List sx={{ 
          flexGrow: 1, 
          overflow: 'auto', 
          p: 0,
          width: '100%',
          maxWidth: '100%',
          WebkitOverflowScrolling: 'touch', // Smooth scrolling on iOS
        }}>
          {filteredNotes.length === 0 ? (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <NoteIcon sx={{ fontSize: isMobile ? 56 : 48, color: 'text.disabled', mb: 1 }} />
              <Typography 
                color="text.secondary" 
                variant="body1"
                sx={{ fontSize: isMobile ? '1.1rem' : '0.9rem' }}
              >
                {searchTerm ? 
                  `No notes found matching "${searchTerm}"` : 
                  (isMobile ? 'No notes yet. Tap the + to create your first note!' : 'No notes yet. Click "New Note" to get started!')
                }
              </Typography>
              {searchTerm && (
                <Typography 
                  variant="body2" 
                  color="text.disabled" 
                  sx={{ 
                    mt: 1,
                    fontSize: isMobile ? '0.95rem' : '0.875rem'
                  }}
                >
                  Try a different search term or{' '}
                  <span 
                    style={{ cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={clearSearch}
                  >
                    clear search
                  </span>
                </Typography>
              )}
            </Box>
          ) : (
            filteredNotes.map((note, index) => renderNoteItem(note, index))
          )}
        </List>
      </Paper>

      {/* Mobile delete confirmation drawer */}
      {isMobile && (
        <SwipeableDrawer
          anchor="bottom"
          open={!!swipeNote}
          onClose={() => setSwipeNote(null)}
          onOpen={() => {}}
          disableSwipeToOpen
          PaperProps={{
            sx: {
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              px: 2,
              pb: 2
            }
          }}
        >
          <Box sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="h6" gutterBottom>
              Delete Note
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Are you sure you want to delete "{swipeNote?.title || 'Untitled'}"?
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <button
                onClick={() => setSwipeNote(null)}
                style={{
                  padding: '12px 24px',
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: '8px',
                  backgroundColor: 'transparent',
                  color: theme.palette.text.primary,
                  fontSize: '1rem',
                  cursor: 'pointer',
                  flex: 1,
                  maxWidth: '120px'
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleSwipeDelete(swipeNote)}
                style={{
                  padding: '12px 24px',
                  border: 'none',
                  borderRadius: '8px',
                  backgroundColor: theme.palette.error.main,
                  color: theme.palette.error.contrastText,
                  fontSize: '1rem',
                  cursor: 'pointer',
                  flex: 1,
                  maxWidth: '120px'
                }}
              >
                Delete
              </button>
            </Box>
          </Box>
        </SwipeableDrawer>
      )}
    </>
  );
};

export default NotesList;
