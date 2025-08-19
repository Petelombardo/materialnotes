#!/bin/bash
# Quick one-liner to fix the corrupted emojis in NoteEditor.js

# Create a backup of the original file
cp NoteEditor.js NoteEditor.js.bak

# Use sed to replace corrupted characters with appropriate emojis
sed -i '' \
  -e 's/ðŸ"„/📄/g' \
  -e 's/ðŸ'¥/👥/g' \
  -e 's/âœ…/✅/g' \
  -e 's/âš ï¸/⚠️/g' \
  -e 's/ðŸ"¡/💡/g' \
  -e 's/ðŸ"¥/📥/g' \
  -e 's/ðŸ'¾/💾/g' \
  -e 's/ðŸ"/📝/g' \
  -e 's/ðŸ§¹/🧹/g' \
  -e 's/ðŸ"±/📱/g' \
  -e 's/ðŸ"Œ/📌/g' \
  -e 's/â­/⭐/g' \
  -e 's/âš¡/⚡/g' \
  -e 's/â°/⏰/g' \
  -e 's/ðŸ›'/🛑/g' \
  -e 's/ðŸ§ /🧠/g' \
  -e 's/ðŸ"§/🔧/g' \
  -e 's/ðŸ"€/🔀/g' \
  -e 's/ðŸ'¤/🤝/g' \
  -e 's/âŒ/❌/g' \
  -e 's/ðŸ—'ï¸/🗑️/g' \
  NoteEditor.js

# For Linux systems, remove the empty string after -i
# sed -i \
#   -e 's/ðŸ"„/📄/g' \
#   ... and so on ... \
#   NoteEditor.js

echo "✅ Emoji encoding fixed in NoteEditor.js (backup saved as NoteEditor.js.bak)"
