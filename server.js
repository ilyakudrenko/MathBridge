const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve static files

// Initialize database
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    // Create users table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      firstName TEXT,
      lastName TEXT,
      phone TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Error creating table:', err.message);
      } else {
        console.log('Users table ready.');
      }
    });

    // Create appointments table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      appointmentDate DATETIME NOT NULL,
      duration INTEGER DEFAULT 30,
      tutorName TEXT,
      status TEXT DEFAULT 'scheduled',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id)
    )`, (err) => {
      if (err) {
        console.error('Error creating appointments table:', err.message);
      } else {
        console.log('Appointments table ready.');
      }
    });

    // Create tutors table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS tutors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT,
      bio TEXT,
      image TEXT,
      email TEXT,
      phone TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Error creating tutors table:', err.message);
      } else {
        console.log('Tutors table ready.');
      }
    });

    // Create user_classes table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS user_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      className TEXT NOT NULL,
      classId TEXT NOT NULL,
      enrolledAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id),
      UNIQUE(userId, classId)
    )`, (err) => {
      if (err) {
        console.error('Error creating user_classes table:', err.message);
      } else {
        console.log('User classes table ready.');
      }
    });
  }
});

// Admin email
const ADMIN_EMAIL = 'ilya.kudrenko@gmail.com';

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
  if (req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Routes

// Sign up
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user already exists
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (row) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Insert new user
      db.run(
        'INSERT INTO users (email, password, firstName, lastName, phone) VALUES (?, ?, ?, ?, ?)',
        [email, hashedPassword, firstName || null, lastName || null, phone || null],
        function(err) {
          if (err) {
            return res.status(500).json({ error: 'Error creating user' });
          }

          // Generate JWT token
          const token = jwt.sign(
            { id: this.lastID, email },
            JWT_SECRET,
            { expiresIn: '7d' }
          );

          res.status(201).json({
            message: 'User created successfully',
            token,
            user: {
              id: this.lastID,
              email,
              firstName: firstName || null,
              lastName: lastName || null,
              phone: phone || null
            }
          });
        }
      );
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (!row) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, row.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: row.id, email: row.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const isAdmin = row.email === ADMIN_EMAIL;

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone,
        isAdmin: isAdmin
      }
    });
  });
});

// Get current user profile
app.get('/api/profile', authenticateToken, (req, res) => {
  db.get('SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (!row) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: row });
  });
});

// Update user profile
app.put('/api/profile', authenticateToken, (req, res) => {
  const { firstName, lastName, phone } = req.body;

  db.run(
    'UPDATE users SET firstName = ?, lastName = ?, phone = ? WHERE id = ?',
    [firstName || null, lastName || null, phone || null, req.user.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error updating profile' });
      }

      // Get updated user
      db.get('SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE id = ?', [req.user.id], (err, row) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        res.json({ message: 'Profile updated successfully', user: row });
      });
    }
  );
});

// Get user's appointments
app.get('/api/appointments', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM appointments WHERE userId = ? ORDER BY appointmentDate ASC',
    [req.user.id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ appointments: rows });
    }
  );
});

// Create new appointment
app.post('/api/appointments', authenticateToken, (req, res) => {
  const { title, description, appointmentDate, duration, tutorName } = req.body;

  if (!title || !appointmentDate) {
    return res.status(400).json({ error: 'Title and appointment date are required' });
  }

  db.run(
    'INSERT INTO appointments (userId, title, description, appointmentDate, duration, tutorName) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, title, description || null, appointmentDate, duration || 30, tutorName || null],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error creating appointment' });
      }

      db.get('SELECT * FROM appointments WHERE id = ?', [this.lastID], (err, row) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        res.status(201).json({ message: 'Appointment created successfully', appointment: row });
      });
    }
  );
});

// Get user's enrolled classes
app.get('/api/user-classes', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM user_classes WHERE userId = ? ORDER BY enrolledAt DESC',
    [req.user.id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ classes: rows });
    }
  );
});

// Enroll user in a class
app.post('/api/user-classes', authenticateToken, (req, res) => {
  const { className, classId } = req.body;

  if (!className || !classId) {
    return res.status(400).json({ error: 'Class name and class ID are required' });
  }

  db.run(
    'INSERT INTO user_classes (userId, className, classId) VALUES (?, ?, ?)',
    [req.user.id, className, classId],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'You are already enrolled in this class' });
        }
        return res.status(500).json({ error: 'Error enrolling in class' });
      }

      db.get('SELECT * FROM user_classes WHERE id = ?', [this.lastID], (err, row) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        res.status(201).json({ message: 'Successfully enrolled in class', class: row });
      });
    }
  );
});

// Unenroll user from a class
app.delete('/api/user-classes/:classId', authenticateToken, (req, res) => {
  const classId = req.params.classId;

  db.run(
    'DELETE FROM user_classes WHERE userId = ? AND classId = ?',
    [req.user.id, classId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error unenrolling from class' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Class not found' });
      }
      res.json({ message: 'Successfully unenrolled from class' });
    }
  );
});

// ===== ADMIN ROUTES =====

// Get all tutors (admin only)
app.get('/api/admin/tutors', authenticateToken, isAdmin, (req, res) => {
  db.all('SELECT * FROM tutors ORDER BY createdAt DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ tutors: rows });
  });
});

// Add new tutor (admin only)
app.post('/api/admin/tutors', authenticateToken, isAdmin, (req, res) => {
  const { name, subject, bio, image, email, phone } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  db.run(
    'INSERT INTO tutors (name, subject, bio, image, email, phone) VALUES (?, ?, ?, ?, ?, ?)',
    [name, subject || null, bio || null, image || null, email || null, phone || null],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error creating tutor' });
      }

      db.get('SELECT * FROM tutors WHERE id = ?', [this.lastID], (err, row) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        res.status(201).json({ message: 'Tutor created successfully', tutor: row });
      });
    }
  );
});

// Update tutor (admin only)
app.put('/api/admin/tutors/:id', authenticateToken, isAdmin, (req, res) => {
  const { name, subject, bio, image, email, phone } = req.body;
  const id = req.params.id;

  db.run(
    'UPDATE tutors SET name = ?, subject = ?, bio = ?, image = ?, email = ?, phone = ? WHERE id = ?',
    [name || null, subject || null, bio || null, image || null, email || null, phone || null, id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error updating tutor' });
      }

      db.get('SELECT * FROM tutors WHERE id = ?', [id], (err, row) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
          return res.status(404).json({ error: 'Tutor not found' });
        }
        res.json({ message: 'Tutor updated successfully', tutor: row });
      });
    }
  );
});

// Delete tutor (admin only)
app.delete('/api/admin/tutors/:id', authenticateToken, isAdmin, (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM tutors WHERE id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Error deleting tutor' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Tutor not found' });
    }
    res.json({ message: 'Tutor deleted successfully' });
  });
});

// Get all users (admin only) - exclude admin user from list
app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
  db.all('SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE email != ? ORDER BY createdAt DESC', [ADMIN_EMAIL], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ users: rows });
  });
});

// Update user (admin only)
app.put('/api/admin/users/:id', authenticateToken, isAdmin, (req, res) => {
  const { firstName, lastName, phone } = req.body;
  const id = req.params.id;

  db.run(
    'UPDATE users SET firstName = ?, lastName = ?, phone = ? WHERE id = ?',
    [firstName || null, lastName || null, phone || null, id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error updating user' });
      }

      db.get('SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE id = ?', [id], (err, row) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
          return res.status(404).json({ error: 'User not found' });
        }
        res.json({ message: 'User updated successfully', user: row });
      });
    }
  );
});

// Delete user (admin only)
app.delete('/api/admin/users/:id', authenticateToken, isAdmin, (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Error deleting user' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted successfully' });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

