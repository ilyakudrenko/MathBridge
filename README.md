# MathBridge Tutoring Website

A modern tutoring website with user authentication and profile management.

## Features

- **User Authentication**: Sign up and login functionality
- **User Profiles**: View and edit personal information
- **Secure Backend**: JWT-based authentication with password hashing
- **SQLite Database**: Simple, file-based database for user storage

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory (or update the existing one):

```
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
PORT=3000
```

**Important**: Change the `JWT_SECRET` to a strong, random string in production!

### 3. Start the Server

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

The server will start on `http://localhost:3000`

### 4. Access the Website

Open your browser and navigate to:
- **Homepage**: `http://localhost:3000/index.html`
- **Sign Up**: `http://localhost:3000/signup.html`
- **Login**: `http://localhost:3000/login.html`
- **Profile**: `http://localhost:3000/profile.html` (requires login)

## Project Structure

```
Tutoring_demo/
├── server.js          # Express backend server
├── package.json       # Node.js dependencies
├── database.sqlite    # SQLite database (created automatically)
├── index.html         # Homepage
├── login.html         # Login page
├── signup.html        # Sign up page
├── profile.html       # User profile page
├── css/
│   └── style.css      # Stylesheet
└── img/               # Images
```

## API Endpoints

### POST `/api/signup`
Create a new user account.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "firstName": "John",
  "lastName": "Doe",
  "phone": "+1234567890"
}
```

**Response:**
```json
{
  "message": "User created successfully",
  "token": "jwt_token_here",
  "user": { ... }
}
```

### POST `/api/login`
Login with email and password.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "message": "Login successful",
  "token": "jwt_token_here",
  "user": { ... }
}
```

### GET `/api/profile`
Get current user's profile (requires authentication).

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "phone": "+1234567890",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### PUT `/api/profile`
Update user profile (requires authentication).

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "phone": "+0987654321"
}
```

## Security Notes

- Passwords are hashed using bcrypt before storage
- JWT tokens expire after 7 days
- All API endpoints (except signup/login) require authentication
- Change the `JWT_SECRET` in production to a strong, random value

## Development

The database is automatically created when the server starts. The `database.sqlite` file will be created in the root directory.

To reset the database, simply delete the `database.sqlite` file and restart the server.

## Production Deployment

Before deploying to production:

1. Change `JWT_SECRET` in `.env` to a strong, random string
2. Consider using a production database (PostgreSQL, MySQL) instead of SQLite
3. Set up HTTPS for secure communication
4. Configure CORS properly for your domain
5. Set up proper error logging and monitoring



