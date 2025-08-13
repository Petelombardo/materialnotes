# Material Notes

A modern note-taking application with WYSIWYG editing, auto-save, and multi-user support.

## Features

- 📝 **WYSIWYG Editor** - Rich text editing with markdown storage
- 🔄 **Auto-save** - Automatic saving of your notes
- 🔐 **OAuth Authentication** - Google & Office 365 sign-in support
- 👥 **Multi-user Support** - Individual folders for each user
- 🎨 **Material Design** - Clean and modern interface
- 🐳 **Docker Deployment** - Easy containerized setup
- 📱 **Responsive Design** - Works on desktop and mobile

## Project Structure

```
materialnotes/
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   └── routes/
│       ├── auth.js
│       └── notes.js
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── public/
│   │   └── index.html
│   └── src/
│       ├── App.js
│       ├── index.js
│       ├── components/
│       │   ├── Login.js
│       │   ├── NoteEditor.js
│       │   └── NotesList.js
│       └── utils/
│           └── api.js
└── nginx/
    ├── Dockerfile
    └── nginx.conf
```

## Setup Instructions

### 1. Authentication Setup

#### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `http://localhost:3001/auth/google/callback`

#### Office 365 OAuth

1. Go to [Azure Portal](https://portal.azure.com/)
2. Register a new app in Azure AD
3. Add redirect URI: `http://localhost:3001/auth/microsoft/callback`
4. Generate client secret

### 2. Environment Variables

Create a `.env` file in the root directory:

```env
# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Microsoft OAuth
MICROSOFT_CLIENT_ID=your_microsoft_client_id
MICROSOFT_CLIENT_SECRET=your_microsoft_client_secret

# App Settings
JWT_SECRET=your_jwt_secret_key
NODE_ENV=production
PORT=3001
```

### 3. Deploy with Docker

```bash
# Clone/create the project directory
git clone https://github.com/Petelombardo/materialnotes.git

# Add your .env file with the required environment variables

# Build and run the application
docker-compose up --build
```

## Usage

Once deployed, access the application at `http://localhost:3000`

1. Sign in using your Google or Office 365 account
2. Start creating and editing notes with the WYSIWYG editor
3. Your notes are automatically saved and organized in your personal folder

## Requirements

- Docker
- Docker Compose
- Google OAuth credentials (optional)
- Microsoft OAuth credentials (optional)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

This project is open source and available under the [GNU General Public License v3.0](LICENSE).

This means:
- ✅ You can use, modify, and distribute this software
- ✅ You can use it for commercial purposes
- ⚠️ Any derivative works must also be GPL 3.0 licensed
- ⚠️ You must provide source code when distributing
- ⚠️ You must include the original copyright and license notices
