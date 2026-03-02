const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './database.sqlite';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const CANCELLATION_WINDOW_HOURS = 24;

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// Middleware -- raw body for Stripe webhook must come before express.json()
app.use(cors());
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('.'));

// Initialize database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    return;
  }

  console.log('Connected to SQLite database.');

  // Debug: show tutors schema
  db.all('PRAGMA table_info(tutors)', (err, rows) => {
    if (err) console.error('PRAGMA error:', err.message);
    else console.log('📋 tutors table columns:', rows);
  });

  // Create users table
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      firstName TEXT,
      lastName TEXT,
      phone TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) console.error('Error creating users table:', err.message);
      else console.log('Users table ready.');
    }
  );

  // Create appointments table
  db.run(
    `CREATE TABLE IF NOT EXISTS appointments (
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
    )`,
    (err) => {
      if (err) console.error('Error creating appointments table:', err.message);
      else console.log('Appointments table ready.');
    }
  );

  // ✅ Create tutors table (IMPORTANT: use createdAt consistently)
  db.run(
    `CREATE TABLE IF NOT EXISTS tutors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT,
      bio TEXT,
      image TEXT,
      email TEXT,
      phone TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        console.error('Error creating tutors table:', err.message);
        return;
      }

      console.log('Tutors table ready.');

      // Migration: add missing columns
      db.all('PRAGMA table_info(tutors)', (e, cols) => {
        if (e) {
          console.error('PRAGMA tutors error:', e.message);
          return;
        }

        const colNames = (cols || []).map((c) => c.name);

        const migrations = [
          { name: 'subjects', sql: 'ALTER TABLE tutors ADD COLUMN subjects TEXT' },
          { name: 'pitch', sql: 'ALTER TABLE tutors ADD COLUMN pitch TEXT' },
          { name: 'rating', sql: 'ALTER TABLE tutors ADD COLUMN rating REAL' },
          { name: 'review_count', sql: 'ALTER TABLE tutors ADD COLUMN review_count INTEGER DEFAULT 0' },
          { name: 'students_count', sql: 'ALTER TABLE tutors ADD COLUMN students_count INTEGER DEFAULT 0' },
          { name: 'lessons_count', sql: 'ALTER TABLE tutors ADD COLUMN lessons_count INTEGER DEFAULT 0' },
          { name: 'calendly_url', sql: 'ALTER TABLE tutors ADD COLUMN calendly_url TEXT' },
        ];

        migrations.forEach(({ name, sql }) => {
          if (!colNames.includes(name)) {
            db.run(sql, (err) => {
              if (err) console.error(`Error adding ${name} column:`, err.message);
              else console.log(`Added ${name} column to tutors table`);
            });
          }
        });
      });
    }
  );

  // Create user_classes table
  db.run(
    `CREATE TABLE IF NOT EXISTS user_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      className TEXT NOT NULL,
      classId TEXT NOT NULL,
      enrolledAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id),
      UNIQUE(userId, classId)
    )`,
    (err) => {
      if (err) console.error('Error creating user_classes table:', err.message);
      else console.log('User classes table ready.');
    }
  );

  // Create enrollments table
  db.run(
    `CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      tutorId INTEGER NOT NULL,
      tutorName TEXT,
      classId TEXT,
      className TEXT,
      eventDate TEXT,
      eventUri TEXT,
      status TEXT DEFAULT 'scheduled',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id),
      FOREIGN KEY (tutorId) REFERENCES tutors(id)
    )`,
    (err) => {
      if (err) console.error('Error creating enrollments table:', err.message);
      else {
        console.log('Enrollments table ready.');
        // Migration: add credit-system columns to enrollments
        db.all('PRAGMA table_info(enrollments)', (e, cols) => {
          if (e) return;
          const names = (cols || []).map(c => c.name);
          const mig = [
            { name: 'duration_minutes', sql: 'ALTER TABLE enrollments ADD COLUMN duration_minutes INTEGER DEFAULT 60' },
            { name: 'creditsCost', sql: 'ALTER TABLE enrollments ADD COLUMN creditsCost INTEGER DEFAULT 0' },
            { name: 'lessonStatus', sql: "ALTER TABLE enrollments ADD COLUMN lessonStatus TEXT DEFAULT 'scheduled'" },
            { name: 'inviteeUri', sql: 'ALTER TABLE enrollments ADD COLUMN inviteeUri TEXT' },
          ];
          mig.forEach(({ name, sql }) => {
            if (!names.includes(name)) db.run(sql, err => { if (!err) console.log(`Added ${name} to enrollments`); });
          });
        });
      }
    }
  );

  // Tutor reviews (user ratings)
  db.run(
    `CREATE TABLE IF NOT EXISTS tutor_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      tutorId INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      comment TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id),
      FOREIGN KEY (tutorId) REFERENCES tutors(id),
      UNIQUE(userId, tutorId)
    )`,
    (err) => {
      if (err) console.error('Error creating tutor_reviews:', err.message);
      else console.log('tutor_reviews table ready.');
    }
  );

  // ===================== CREDITS SYSTEM TABLES =====================

  db.run(
    `CREATE TABLE IF NOT EXISTS credit_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      credits INTEGER NOT NULL,
      price_usd REAL NOT NULL,
      bonus_credits INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    )`,
    (err) => {
      if (err) return console.error('Error creating credit_packs:', err.message);
      console.log('credit_packs table ready.');
      // Seed default packs
      const packs = [
        ['Starter', 45, 45, 0, 1],
        ['Standard', 200, 180, 0, 2],
        ['Advanced', 500, 400, 0, 3],
        ['Elite', 1000, 700, 20, 4],
      ];
      packs.forEach(([name, credits, price, bonus, sort]) => {
        db.run('INSERT OR IGNORE INTO credit_packs (name, credits, price_usd, bonus_credits, sort_order) VALUES (?,?,?,?,?)',
          [name, credits, price, bonus, sort]);
      });
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS subject_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_key TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      credits_per_60min INTEGER NOT NULL
    )`,
    (err) => {
      if (err) return console.error('Error creating subject_rates:', err.message);
      console.log('subject_rates table ready.');
      const rates = [
        ['mathematics', 'Mathematics', 45],
        ['biology', 'Biology', 45],
        ['biology-exam', 'Biology Exam Intensive', 50],
        ['computer-science', 'Computer Science', 50],
        ['cs-advanced', 'CS Advanced (Algorithms)', 55],
        ['ai', 'Artificial Intelligence', 60],
        ['ai-research', 'AI Research Mentoring', 70],
        ['data-science', 'Data Science / Econometrics', 65],
      ];
      rates.forEach(([key, label, rate]) => {
        db.run('INSERT OR IGNORE INTO subject_rates (subject_key, label, credits_per_60min) VALUES (?,?,?)',
          [key, label, rate]);
      });
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS duration_multipliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duration_minutes INTEGER UNIQUE NOT NULL,
      multiplier REAL NOT NULL
    )`,
    (err) => {
      if (err) return console.error('Error creating duration_multipliers:', err.message);
      console.log('duration_multipliers table ready.');
      [[30, 0.6], [60, 1.0], [90, 1.4]].forEach(([dur, mul]) => {
        db.run('INSERT OR IGNORE INTO duration_multipliers (duration_minutes, multiplier) VALUES (?,?)', [dur, mul]);
      });
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      referenceType TEXT,
      referenceId INTEGER,
      metadata TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id),
      UNIQUE(type, referenceType, referenceId)
    )`,
    (err) => {
      if (err) console.error('Error creating credit_ledger:', err.message);
      else console.log('credit_ledger table ready.');
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS credit_holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      enrollmentId INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT DEFAULT 'PENDING',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id),
      FOREIGN KEY (enrollmentId) REFERENCES enrollments(id)
    )`,
    (err) => {
      if (err) console.error('Error creating credit_holds:', err.message);
      else console.log('credit_holds table ready.');
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      packId INTEGER NOT NULL,
      usdAmount REAL NOT NULL,
      creditsIssued INTEGER NOT NULL,
      stripeSessionId TEXT UNIQUE,
      stripePaymentIntent TEXT,
      status TEXT DEFAULT 'pending',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id),
      FOREIGN KEY (packId) REFERENCES credit_packs(id)
    )`,
    (err) => {
      if (err) console.error('Error creating purchases:', err.message);
      else console.log('purchases table ready.');
    }
  );
});

// Admin email
const ADMIN_EMAIL = 'ilya.kudrenko@gmail.com';

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
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

// ===================== AUTH ROUTES =====================

// Sign up
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (row) return res.status(400).json({ error: 'User already exists' });

      const hashedPassword = await bcrypt.hash(password, 10);

      db.run(
        'INSERT INTO users (email, password, firstName, lastName, phone) VALUES (?, ?, ?, ?, ?)',
        [email, hashedPassword, firstName || null, lastName || null, phone || null],
        function (err) {
          if (err) return res.status(500).json({ error: 'Error creating user' });

          const token = jwt.sign({ id: this.lastID, email }, JWT_SECRET, { expiresIn: '7d' });

          res.status(201).json({
            message: 'User created successfully',
            token,
            user: {
              id: this.lastID,
              email,
              firstName: firstName || null,
              lastName: lastName || null,
              phone: phone || null,
            },
          });
        }
      );
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.status(401).json({ error: 'Invalid email or password' });

    const validPassword = await bcrypt.compare(password, row.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: row.id, email: row.email }, JWT_SECRET, { expiresIn: '7d' });
    const admin = row.email === ADMIN_EMAIL;

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone,
        isAdmin: admin,
      },
    });
  });
});

// ===================== PROFILE =====================

app.get('/api/profile', authenticateToken, (req, res) => {
  db.get(
    'SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE id = ?',
    [req.user.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (!row) return res.status(404).json({ error: 'User not found' });
      res.json({ user: row });
    }
  );
});

app.put('/api/profile', authenticateToken, (req, res) => {
  const { firstName, lastName, phone } = req.body;

  db.run(
    'UPDATE users SET firstName = ?, lastName = ?, phone = ? WHERE id = ?',
    [firstName || null, lastName || null, phone || null, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Error updating profile' });

      db.get(
        'SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE id = ?',
        [req.user.id],
        (err, row) => {
          if (err) return res.status(500).json({ error: 'Database error' });
          res.json({ message: 'Profile updated successfully', user: row });
        }
      );
    }
  );
});

// ===================== APPOINTMENTS =====================

app.get('/api/appointments', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM appointments WHERE userId = ? ORDER BY appointmentDate ASC',
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ appointments: rows });
    }
  );
});

app.post('/api/appointments', authenticateToken, (req, res) => {
  const { title, description, appointmentDate, duration, tutorName } = req.body;
  if (!title || !appointmentDate) {
    return res.status(400).json({ error: 'Title and appointment date are required' });
  }

  db.run(
    'INSERT INTO appointments (userId, title, description, appointmentDate, duration, tutorName) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, title, description || null, appointmentDate, duration || 30, tutorName || null],
    function (err) {
      if (err) return res.status(500).json({ error: 'Error creating appointment' });

      db.get('SELECT * FROM appointments WHERE id = ?', [this.lastID], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.status(201).json({ message: 'Appointment created successfully', appointment: row });
      });
    }
  );
});

// ===================== USER CLASSES =====================

app.get('/api/user-classes', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM user_classes WHERE userId = ? ORDER BY enrolledAt DESC',
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ classes: rows });
    }
  );
});

// Student is "enrolled" in a class only if they have at least one active (scheduled, not canceled/completed) upcoming event
app.post('/api/user-classes', authenticateToken, (req, res) => {
  const { className, classId } = req.body;
  if (!className || !classId) return res.status(400).json({ error: 'Class name and class ID are required' });

  const now = new Date().toISOString();
  db.get(
    `SELECT 1 FROM enrollments WHERE userId = ? AND classId = ? AND (lessonStatus IS NULL OR lessonStatus = 'scheduled')
     AND (eventDate IS NULL OR eventDate >= ?) LIMIT 1`,
    [req.user.id, classId, now],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (row) {
        return res.status(400).json({ error: 'You are already enrolled in this class' });
      }

      db.run(
        'INSERT OR IGNORE INTO user_classes (userId, className, classId) VALUES (?, ?, ?)',
        [req.user.id, className, classId],
        function (err) {
          if (err) return res.status(500).json({ error: 'Error enrolling in class' });
          db.get(
            'SELECT * FROM user_classes WHERE userId = ? AND classId = ?',
            [req.user.id, classId],
            (err, row) => {
              if (err) return res.status(500).json({ error: 'Database error' });
              res.status(201).json({ message: 'Successfully enrolled in class', class: row });
            }
          );
        }
      );
    }
  );
});

app.delete('/api/user-classes/:classId', authenticateToken, (req, res) => {
  const classId = req.params.classId;

  db.run('DELETE FROM user_classes WHERE userId = ? AND classId = ?', [req.user.id, classId], function (err) {
    if (err) return res.status(500).json({ error: 'Error unenrolling from class' });
    if (this.changes === 0) return res.status(404).json({ error: 'Class not found' });
    res.json({ message: 'Successfully unenrolled from class' });
  });
});

// ===================== PUBLIC TUTORS =====================

// Public: get tutors with aggregated rating/review_count from tutor_reviews (optionally filtered by subject)
app.get('/api/tutors', (req, res) => {
  const { subject } = req.query;

  const sql = `
    SELECT t.*,
           COALESCE(r.avg_rating, t.rating) AS rating,
           COALESCE(r.review_count, t.review_count, 0) AS review_count
    FROM tutors t
    LEFT JOIN (
      SELECT tutorId, AVG(rating) AS avg_rating, COUNT(*) AS review_count
      FROM tutor_reviews GROUP BY tutorId
    ) r ON t.id = r.tutorId
    ORDER BY t.createdAt DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('❌ /api/tutors DB error:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    let result = rows || [];
    if (subject) {
      result = result.filter((t) => {
        if (!t.subjects) return false;
        try {
          const subs = typeof t.subjects === 'string' ? JSON.parse(t.subjects) : t.subjects;
          return Array.isArray(subs) && subs.includes(subject);
        } catch {
          return false;
        }
      });
    }
    res.json({ tutors: result });
  });
});

// Submit or update a review (one per user per tutor)
app.post('/api/reviews', authenticateToken, (req, res) => {
  const { tutorId, rating, comment } = req.body;
  if (!tutorId || rating == null) return res.status(400).json({ error: 'tutorId and rating (1-5) are required' });
  const r = parseInt(rating, 10);
  if (r < 1 || r > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });

  db.run(
    `INSERT INTO tutor_reviews (userId, tutorId, rating, comment) VALUES (?, ?, ?, ?)
     ON CONFLICT(userId, tutorId) DO UPDATE SET rating = excluded.rating, comment = excluded.comment`,
    [req.user.id, tutorId, r, comment || null],
    function (err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.status(201).json({ message: 'Thank you for your review!', id: this.lastID });
    }
  );
});

// Get current user's review for a tutor (optional, for pre-filling form)
app.get('/api/reviews/me/:tutorId', authenticateToken, (req, res) => {
  db.get(
    'SELECT * FROM tutor_reviews WHERE userId = ? AND tutorId = ?',
    [req.user.id, req.params.tutorId],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ review: row || null });
    }
  );
});

// ===================== ADMIN ROUTES =====================

// Dashboard stats (admin only)
app.get('/api/admin/stats', authenticateToken, isAdmin, (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  db.get('SELECT COUNT(*) AS n FROM tutors', [], (err, r1) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    db.get('SELECT COUNT(*) AS n FROM users', [], (err, r2) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      db.get(
        'SELECT COUNT(*) AS n FROM enrollments WHERE date(eventDate) >= date(?) AND date(eventDate) <= date(?)',
        [startOfMonth, endOfMonth],
        (err, r3) => {
          if (err) return res.status(500).json({ error: 'Database error' });
          db.get(
            "SELECT COUNT(*) AS n FROM enrollments WHERE lessonStatus = 'completed'",
            [],
            (err, r4) => {
              if (err) return res.status(500).json({ error: 'Database error' });
              res.json({
                totalTutors: r1?.n ?? 0,
                totalUsers: r2?.n ?? 0,
                enrollmentsThisMonth: r3?.n ?? 0,
                completedLessons: r4?.n ?? 0,
              });
            }
          );
        }
      );
    });
  });
});

// Get all tutors (admin only)
app.get('/api/admin/tutors', authenticateToken, isAdmin, (req, res) => {
  db.all('SELECT * FROM tutors ORDER BY createdAt DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ tutors: rows });
  });
});

// Add new tutor (admin only)
app.post('/api/admin/tutors', authenticateToken, isAdmin, (req, res) => {
  const { name, subjects, bio, pitch, image, email, phone, calendly_url } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const subjectsJson = Array.isArray(subjects) ? JSON.stringify(subjects) : null;

  db.run(
    'INSERT INTO tutors (name, subjects, bio, pitch, image, email, phone, calendly_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name, subjectsJson, bio || null, pitch || null, image || null, email || null, phone || null, calendly_url || null],
    function (err) {
      if (err) return res.status(500).json({ error: 'Error creating tutor' });

      db.get('SELECT * FROM tutors WHERE id = ?', [this.lastID], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.status(201).json({ message: 'Tutor created successfully', tutor: row });
      });
    }
  );
});

// Update tutor (admin only)
app.put('/api/admin/tutors/:id', authenticateToken, isAdmin, (req, res) => {
  const { name, subjects, bio, pitch, image, email, phone, calendly_url } = req.body;
  const id = req.params.id;

  const subjectsJson = Array.isArray(subjects) ? JSON.stringify(subjects) : null;

  db.run(
    'UPDATE tutors SET name = ?, subjects = ?, bio = ?, pitch = ?, image = ?, email = ?, phone = ?, calendly_url = ? WHERE id = ?',
    [name || null, subjectsJson, bio || null, pitch || null, image || null, email || null, phone || null, calendly_url || null, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Error updating tutor' });

      db.get('SELECT * FROM tutors WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!row) return res.status(404).json({ error: 'Tutor not found' });
        res.json({ message: 'Tutor updated successfully', tutor: row });
      });
    }
  );
});

// Delete tutor (admin only)
app.delete('/api/admin/tutors/:id', authenticateToken, isAdmin, (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM tutors WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: 'Error deleting tutor' });
    if (this.changes === 0) return res.status(404).json({ error: 'Tutor not found' });
    res.json({ message: 'Tutor deleted successfully' });
  });
});

// Get all users (admin only)
app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
  db.all(
    'SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE email != ? ORDER BY createdAt DESC',
    [ADMIN_EMAIL],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ users: rows });
    }
  );
});

// Update user (admin only)
app.put('/api/admin/users/:id', authenticateToken, isAdmin, (req, res) => {
  const { firstName, lastName, phone } = req.body;
  const id = req.params.id;

  db.run(
    'UPDATE users SET firstName = ?, lastName = ?, phone = ? WHERE id = ?',
    [firstName || null, lastName || null, phone || null, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Error updating user' });

      db.get(
        'SELECT id, email, firstName, lastName, phone, createdAt FROM users WHERE id = ?',
        [id],
        (err, row) => {
          if (err) return res.status(500).json({ error: 'Database error' });
          if (!row) return res.status(404).json({ error: 'User not found' });
          res.json({ message: 'User updated successfully', user: row });
        }
      );
    }
  );
});

// Delete user (admin only)
app.delete('/api/admin/users/:id', authenticateToken, isAdmin, (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM users WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: 'Error deleting user' });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  });
});

// ===================== ENROLLMENTS =====================

const classNames = {
  mathematics: 'Mathematics',
  biology: 'Biology',
  ai: 'Artificial Intelligence',
  'computer-science': 'Computer Science',
};

// Fetch real start_time from Calendly API using the event URI
async function fetchCalendlyEventDate(eventUri) {
  const token = process.env.CALENDLY_API_TOKEN;
  if (!token || !eventUri) return null;
  try {
    const resp = await fetch(eventUri, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      console.error('Calendly API error:', resp.status, resp.statusText);
      return null;
    }
    const data = await resp.json();
    return (data.resource && data.resource.start_time) || null;
  } catch (e) {
    console.error('Calendly API fetch error:', e.message);
    return null;
  }
}

// Cancel the event in Calendly (frees the slot). Prefer inviteeUri; fallback to eventUri.
async function cancelCalendlyEvent(enrollment) {
  const token = process.env.CALENDLY_API_TOKEN;
  if (!token) return;
  const uri = enrollment.inviteeUri || enrollment.eventUri;
  if (!uri) return;
  try {
    const resp = await fetch(uri, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      console.log('Calendly event canceled:', uri);
    } else {
      console.warn('Calendly cancel failed:', resp.status, resp.statusText, await resp.text());
    }
  } catch (e) {
    console.error('Calendly cancel error:', e.message);
  }
}

// Enroll: save enrollment + hold credits + send email to tutor
app.post('/api/enroll', authenticateToken, async (req, res) => {
  const { tutorId, classId, eventDate, eventUri, inviteeUri, durationMinutes, subjectKey } = req.body;
  if (!tutorId || !classId) {
    return res.status(400).json({ error: 'Tutor and class are required' });
  }

  const className = classNames[classId] || classId;
  const duration = durationMinutes || 60;
  const rateKey = subjectKey || classId;

  // Calculate credit cost
  let creditsCost = 0;
  try {
    const cost = await calculateCost(rateKey, duration);
    creditsCost = cost || 0;
  } catch (e) {
    console.error('Cost calc error:', e.message);
  }

  // Check balance if credits are required
  if (creditsCost > 0) {
    try {
      const balance = await getAvailableBalance(req.user.id);
      if (balance < creditsCost) {
        return res.status(402).json({
          error: 'Insufficient credits',
          required: creditsCost,
          available: balance,
          shortfall: creditsCost - balance,
        });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Balance check failed' });
    }
  }

  // Resolve real date from Calendly API
  let resolvedDate = eventDate || null;
  if (eventUri) {
    const calendlyDate = await fetchCalendlyEventDate(eventUri);
    if (calendlyDate) resolvedDate = calendlyDate;
  }

  try {
    const tutor = await dbGet('SELECT * FROM tutors WHERE id = ?', [tutorId]);
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' });

    const student = await dbGet('SELECT id, email, firstName, lastName, phone FROM users WHERE id = ?', [req.user.id]);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // Atomic: enrollment + hold + ledger (inviteeUri used later for Calendly cancel)
    const enrollResult = await dbRun(
      'INSERT INTO enrollments (userId, tutorId, tutorName, classId, className, eventDate, eventUri, inviteeUri, duration_minutes, creditsCost, lessonStatus) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [req.user.id, tutorId, tutor.name, classId, className, resolvedDate, eventUri || null, inviteeUri || null, duration, creditsCost, 'scheduled']
    );
    const enrollmentId = enrollResult.lastID;

    // Create credit hold + ledger entry
    if (creditsCost > 0) {
      await dbRun(
        'INSERT INTO credit_holds (userId, enrollmentId, amount, status) VALUES (?,?,?,?)',
        [req.user.id, enrollmentId, creditsCost, 'PENDING']
      );
      await dbRun(
        'INSERT INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
        [req.user.id, -creditsCost, 'HOLD_CREATE', 'enrollment', enrollmentId,
         JSON.stringify({ class: className, tutor: tutor.name, duration, creditsCost })]
      );
    }

    await dbRun('INSERT OR IGNORE INTO user_classes (userId, className, classId) VALUES (?,?,?)',
      [req.user.id, className, classId]);

    // Send email notification to tutor
    const studentName = [student.firstName, student.lastName].filter(Boolean).join(' ') || student.email;
    const dateDisplay = resolvedDate
      ? new Date(resolvedDate).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
      : 'TBD';

    if (tutor.email && process.env.GMAIL_USER) {
      const mailOptions = {
        from: `"Core School" <${process.env.GMAIL_USER}>`,
        to: tutor.email,
        subject: `New Lesson Booking — ${className}`,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
            <h2 style="color:#0077ff;">New Lesson Scheduled</h2>
            <p>Hi <strong>${tutor.name}</strong>,</p>
            <p>A student has booked a lesson with you through Core School.</p>
            <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Class:</strong></td><td style="padding:.5rem 0;">${className}</td></tr>
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Student:</strong></td><td style="padding:.5rem 0;">${studentName}</td></tr>
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Email:</strong></td><td style="padding:.5rem 0;">${student.email}</td></tr>
              ${student.phone ? `<tr><td style="padding:.5rem 0;color:#555;"><strong>Phone:</strong></td><td style="padding:.5rem 0;">${student.phone}</td></tr>` : ''}
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Date:</strong></td><td style="padding:.5rem 0;">${dateDisplay}</td></tr>
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Duration:</strong></td><td style="padding:.5rem 0;">${duration} min</td></tr>
            </table>
            <p style="color:#888;font-size:.85rem;">This is an automated notification from Core School.</p>
          </div>
        `,
      };
      mailTransporter.sendMail(mailOptions, (mailErr) => {
        if (mailErr) console.error('Email send error:', mailErr.message);
        else console.log(`Email sent to tutor ${tutor.email}`);
      });
    } else {
      console.log(`[DEMO] Would email ${tutor.email}: New ${className} lesson from ${studentName} on ${dateDisplay}`);
    }

    const enrollment = await dbGet('SELECT * FROM enrollments WHERE id = ?', [enrollmentId]);
    res.status(201).json({ message: 'Enrolled successfully', enrollment, creditsCost });
  } catch (e) {
    console.error('Enroll error:', e.message);
    res.status(500).json({ error: 'Error creating enrollment' });
  }
});

// Get enrollments for logged-in user (includes full tutor details)
app.get('/api/enrollments', authenticateToken, (req, res) => {
  db.all(
    `SELECT e.*,
            t.image    AS tutorImage,
            t.email    AS tutorEmail,
            t.phone    AS tutorPhone,
            t.bio      AS tutorBio,
            t.pitch    AS tutorPitch,
            t.subjects AS tutorSubjects,
            t.rating   AS tutorRating,
            t.review_count   AS tutorReviewCount,
            t.students_count AS tutorStudentsCount,
            t.lessons_count  AS tutorLessonsCount
     FROM enrollments e
     LEFT JOIN tutors t ON t.id = e.tutorId
     WHERE e.userId = ?
     ORDER BY e.createdAt DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ enrollments: rows });
    }
  );
});

// Admin: list all enrollments with student and tutor info
app.get('/api/admin/enrollments', authenticateToken, isAdmin, (req, res) => {
  const { status } = req.query;
  let sql = `
    SELECT e.id, e.userId, e.tutorId, e.tutorName, e.classId, e.className,
           e.eventDate, e.eventUri, e.duration_minutes, e.creditsCost,
           e.lessonStatus, e.createdAt,
           u.email AS studentEmail, u.firstName AS studentFirstName, u.lastName AS studentLastName
    FROM enrollments e
    LEFT JOIN users u ON u.id = e.userId
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    sql += ' AND e.lessonStatus = ?';
    params.push(status);
  }
  sql += ' ORDER BY e.eventDate IS NULL, e.eventDate ASC, e.createdAt DESC';

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ enrollments: rows });
  });
});

// ===================== CREDIT HELPERS =====================

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}

async function getAvailableBalance(userId) {
  const row = await dbGet('SELECT COALESCE(SUM(amount),0) AS balance FROM credit_ledger WHERE userId = ?', [userId]);
  return row.balance;
}

async function getHeldCredits(userId) {
  const row = await dbGet("SELECT COALESCE(SUM(amount),0) AS held FROM credit_holds WHERE userId = ? AND status = 'PENDING'", [userId]);
  return row.held;
}

async function calculateCost(subjectKey, durationMinutes) {
  const rate = await dbGet('SELECT credits_per_60min FROM subject_rates WHERE subject_key = ?', [subjectKey]);
  if (!rate) return null;
  const mul = await dbGet('SELECT multiplier FROM duration_multipliers WHERE duration_minutes = ?', [durationMinutes]);
  const multiplier = mul ? mul.multiplier : durationMinutes / 60;
  return Math.ceil(rate.credits_per_60min * multiplier);
}

// ===================== CREDITS API =====================

// Get available packs
app.get('/api/credits/packs', (req, res) => {
  db.all('SELECT * FROM credit_packs WHERE active = 1 ORDER BY sort_order ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ packs: rows });
  });
});

// Get balance
app.get('/api/credits/balance', authenticateToken, async (req, res) => {
  try {
    const balance = await getAvailableBalance(req.user.id);
    const held = await getHeldCredits(req.user.id);
    res.json({ available: balance, held, total: balance + held });
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Get ledger
app.get('/api/credits/ledger', authenticateToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  db.all(
    'SELECT * FROM credit_ledger WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?',
    [req.user.id, limit, offset],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ ledger: rows });
    }
  );
});

// Get subject rates + duration multipliers
app.get('/api/credits/rates', (req, res) => {
  db.all('SELECT * FROM subject_rates ORDER BY label', [], (err, rates) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    db.all('SELECT * FROM duration_multipliers ORDER BY duration_minutes', [], (err2, muls) => {
      if (err2) return res.status(500).json({ error: 'Database error' });
      res.json({ rates, multipliers: muls });
    });
  });
});

// Cost preview
app.post('/api/credits/cost-preview', async (req, res) => {
  const { subjectKey, durationMinutes } = req.body;
  if (!subjectKey || !durationMinutes) return res.status(400).json({ error: 'subjectKey and durationMinutes required' });
  try {
    const cost = await calculateCost(subjectKey, durationMinutes);
    if (cost === null) return res.status(404).json({ error: 'Subject rate not found' });
    res.json({ cost, subjectKey, durationMinutes });
  } catch (e) {
    res.status(500).json({ error: 'Calculation error' });
  }
});

// ===================== STRIPE PURCHASE =====================

app.post('/api/credits/purchase', authenticateToken, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });

  try {
    const pack = await dbGet('SELECT * FROM credit_packs WHERE id = ? AND active = 1', [packId]);
    if (!pack) return res.status(404).json({ error: 'Pack not found' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `${pack.name} — ${pack.credits} Credits` },
          unit_amount: Math.round(pack.price_usd * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/credits.html?success=1`,
      cancel_url: `${req.protocol}://${req.get('host')}/credits.html?canceled=1`,
      metadata: { userId: String(req.user.id), packId: String(pack.id) },
    });

    await dbRun(
      'INSERT INTO purchases (userId, packId, usdAmount, creditsIssued, stripeSessionId, status) VALUES (?,?,?,?,?,?)',
      [req.user.id, pack.id, pack.price_usd, pack.credits + pack.bonus_credits, session.id, 'pending']
    );

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe session error:', e.message);
    const message = e.type === 'StripeAuthenticationError' ? 'Invalid Stripe API key. Check STRIPE_SECRET_KEY in .env' : 'Payment error';
    res.status(500).json({ error: message });
  }
});

// Stripe webhook (must be hit by Stripe CLI when testing locally: stripe listen --forward-to localhost:3000/api/stripe/webhook)
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.sendStatus(400);
  const sig = req.headers['stripe-signature'];
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not set. Run: stripe listen --forward-to localhost:3000/api/stripe/webhook and add the whsec_... to .env');
    return res.status(500).send('Webhook secret not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  console.log('Stripe webhook received:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      const purchase = await dbGet('SELECT * FROM purchases WHERE stripeSessionId = ?', [session.id]);
      if (!purchase || purchase.status === 'completed') return res.json({ received: true });

      await dbRun('UPDATE purchases SET status = ?, stripePaymentIntent = ? WHERE id = ?',
        ['completed', session.payment_intent, purchase.id]);

      const pack = await dbGet('SELECT * FROM credit_packs WHERE id = ?', [purchase.packId]);
      const totalCredits = pack.credits + pack.bonus_credits;

      // PURCHASE_ISSUE ledger entry
      await dbRun(
        'INSERT OR IGNORE INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
        [purchase.userId, totalCredits, 'PURCHASE_ISSUE', 'purchase', purchase.id,
         JSON.stringify({ pack: pack.name, usd: pack.price_usd, bonus: pack.bonus_credits })]
      );

      // Separate BONUS entry for Elite pack
      if (pack.bonus_credits > 0) {
        await dbRun(
          'INSERT OR IGNORE INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
          [purchase.userId, 0, 'BONUS', 'purchase_bonus', purchase.id,
           JSON.stringify({ reason: `${pack.name} pack bonus`, note: 'included in PURCHASE_ISSUE total' })]
        );
      }

      console.log(`Credits issued: ${totalCredits} to user ${purchase.userId}`);
    } catch (e) {
      console.error('Webhook processing error:', e.message);
    }
  }

  res.json({ received: true });
});

// ===================== BOOKING WITH CREDITS =====================

// Modified enroll endpoint is above; we now override it with credit-aware version
// (The original POST /api/enroll is replaced in-place above)

// ===================== LESSON LIFECYCLE =====================

// Complete lesson (admin)
app.post('/api/lessons/:enrollmentId/complete', authenticateToken, isAdmin, async (req, res) => {
  const { enrollmentId } = req.params;
  try {
    const enrollment = await dbGet('SELECT * FROM enrollments WHERE id = ?', [enrollmentId]);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });
    if (enrollment.lessonStatus && enrollment.lessonStatus !== 'scheduled')
      return res.status(400).json({ error: `Lesson already ${enrollment.lessonStatus}` });

    const hold = await dbGet("SELECT * FROM credit_holds WHERE enrollmentId = ? AND status = 'PENDING'", [enrollmentId]);

    await dbRun("UPDATE enrollments SET lessonStatus = 'completed' WHERE id = ?", [enrollmentId]);

    if (hold) {
      await dbRun("UPDATE credit_holds SET status = 'SETTLED' WHERE id = ?", [hold.id]);
      await dbRun(
        'INSERT OR IGNORE INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
        [enrollment.userId, 0, 'DEBIT_FINAL', 'enrollment', enrollmentId,
         JSON.stringify({ action: 'completed', creditsCost: enrollment.creditsCost || hold.amount })]
      );
    }

    res.json({ message: 'Lesson marked as completed' });
  } catch (e) {
    console.error('Complete error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cancel lesson (student or admin)
app.post('/api/lessons/:enrollmentId/cancel', authenticateToken, async (req, res) => {
  const { enrollmentId } = req.params;
  try {
    const enrollment = await dbGet('SELECT * FROM enrollments WHERE id = ?', [enrollmentId]);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    const isOwner = enrollment.userId === req.user.id;
    const isAdminUser = req.user.email === ADMIN_EMAIL;
    if (!isOwner && !isAdminUser) return res.status(403).json({ error: 'Not authorized' });

    if (enrollment.lessonStatus && enrollment.lessonStatus !== 'scheduled')
      return res.status(400).json({ error: `Lesson already ${enrollment.lessonStatus}` });

    const hold = await dbGet("SELECT * FROM credit_holds WHERE enrollmentId = ? AND status = 'PENDING'", [enrollmentId]);
    let refundAmount = 0;
    let chargeAmount = 0;

    if (hold) {
      // Determine refund based on time until event
      let hoursUntil = Infinity;
      if (enrollment.eventDate) {
        const eventTime = new Date(enrollment.eventDate).getTime();
        hoursUntil = (eventTime - Date.now()) / (1000 * 60 * 60);
      }

      if (hoursUntil >= CANCELLATION_WINDOW_HOURS) {
        refundAmount = hold.amount;
        chargeAmount = 0;
      } else {
        refundAmount = Math.floor(hold.amount / 2);
        chargeAmount = hold.amount - refundAmount;
      }

      await dbRun("UPDATE credit_holds SET status = 'RELEASED' WHERE id = ?", [hold.id]);

      // Release the held credits back (positive entry reverses the negative HOLD_CREATE)
      if (refundAmount > 0) {
        await dbRun(
          'INSERT OR IGNORE INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
          [enrollment.userId, refundAmount, 'HOLD_RELEASE', 'enrollment', enrollmentId,
           JSON.stringify({ refundPercent: hoursUntil >= CANCELLATION_WINDOW_HOURS ? 100 : 50, hoursUntil: Math.round(hoursUntil) })]
        );
      }
      // If partial charge, record the final debit (the remaining credits are "consumed")
      if (chargeAmount > 0) {
        await dbRun(
          'INSERT OR IGNORE INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
          [enrollment.userId, 0, 'DEBIT_FINAL', 'enrollment_cancel', enrollmentId,
           JSON.stringify({ charged: chargeAmount, reason: 'Late cancellation penalty' })]
        );
      }
    }

    await dbRun("UPDATE enrollments SET lessonStatus = 'canceled' WHERE id = ?", [enrollmentId]);

    // Cancel in Calendly so the slot is freed
    await cancelCalendlyEvent(enrollment);

    // Notify tutor by email
    const tutor = await dbGet('SELECT id, name, email FROM tutors WHERE id = ?', [enrollment.tutorId]);
    const student = await dbGet('SELECT firstName, lastName, email FROM users WHERE id = ?', [enrollment.userId]);
    if (tutor && tutor.email && student) {
      const studentName = [student.firstName, student.lastName].filter(Boolean).join(' ') || student.email;
      const dateDisplay = enrollment.eventDate
        ? new Date(enrollment.eventDate).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
        : 'TBD';
      const mailOptions = {
        from: `"Core School" <${process.env.GMAIL_USER}>`,
        to: tutor.email,
        subject: `Lesson Canceled — ${enrollment.className}`,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
            <h2 style="color:#d32f2f;">Lesson Canceled</h2>
            <p>Hi <strong>${tutor.name}</strong>,</p>
            <p>A student has canceled a lesson that was scheduled with you.</p>
            <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Class:</strong></td><td style="padding:.5rem 0;">${enrollment.className}</td></tr>
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Student:</strong></td><td style="padding:.5rem 0;">${studentName}</td></tr>
              <tr><td style="padding:.5rem 0;color:#555;"><strong>Was scheduled:</strong></td><td style="padding:.5rem 0;">${dateDisplay}</td></tr>
            </table>
            <p style="color:#888;font-size:.85rem;">This is an automated notification from Core School.</p>
          </div>
        `,
      };
      if (process.env.GMAIL_USER) {
        mailTransporter.sendMail(mailOptions, (mailErr) => {
          if (mailErr) console.error('Cancel email error:', mailErr.message);
          else console.log(`Cancel notification sent to tutor ${tutor.email}`);
        });
      } else {
        console.log(`[DEMO] Would email ${tutor.email}: Lesson canceled — ${enrollment.className}, ${studentName}, ${dateDisplay}`);
      }
    }

    res.json({ message: 'Lesson canceled', refundedCredits: refundAmount, chargedCredits: chargeAmount });
  } catch (e) {
    console.error('Cancel error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// No-show (admin only)
app.post('/api/lessons/:enrollmentId/no-show', authenticateToken, isAdmin, async (req, res) => {
  const { enrollmentId } = req.params;
  try {
    const enrollment = await dbGet('SELECT * FROM enrollments WHERE id = ?', [enrollmentId]);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });
    if (enrollment.lessonStatus && enrollment.lessonStatus !== 'scheduled')
      return res.status(400).json({ error: `Lesson already ${enrollment.lessonStatus}` });

    const hold = await dbGet("SELECT * FROM credit_holds WHERE enrollmentId = ? AND status = 'PENDING'", [enrollmentId]);
    if (hold) {
      await dbRun("UPDATE credit_holds SET status = 'SETTLED' WHERE id = ?", [hold.id]);
      await dbRun(
        'INSERT OR IGNORE INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
        [enrollment.userId, 0, 'DEBIT_FINAL', 'enrollment_noshow', enrollmentId,
         JSON.stringify({ charged: hold.amount, reason: 'No-show — full charge' })]
      );
    }
    await dbRun("UPDATE enrollments SET lessonStatus = 'no_show' WHERE id = ?", [enrollmentId]);
    res.json({ message: 'Lesson marked as no-show, full credits charged' });
  } catch (e) {
    console.error('No-show error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===================== ADMIN CREDITS MANAGEMENT =====================

// Adjust credits
app.post('/api/admin/credits/adjust', authenticateToken, isAdmin, async (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId || amount === undefined) return res.status(400).json({ error: 'userId and amount required' });

  try {
    const user = await dbGet('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await dbRun(
      'INSERT INTO credit_ledger (userId, amount, type, referenceType, referenceId, metadata) VALUES (?,?,?,?,?,?)',
      [userId, amount, 'ADJUSTMENT', 'admin', Date.now(),
       JSON.stringify({ reason: reason || 'Admin adjustment', adjustedBy: req.user.email })]
    );

    const balance = await getAvailableBalance(userId);
    res.json({ message: 'Credits adjusted', newBalance: balance });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Subject rates CRUD
app.get('/api/admin/subject-rates', authenticateToken, isAdmin, (req, res) => {
  db.all('SELECT * FROM subject_rates ORDER BY label', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ rates: rows });
  });
});

app.post('/api/admin/subject-rates', authenticateToken, isAdmin, (req, res) => {
  const { subject_key, label, credits_per_60min } = req.body;
  if (!subject_key || !label || !credits_per_60min) return res.status(400).json({ error: 'All fields required' });
  db.run('INSERT INTO subject_rates (subject_key, label, credits_per_60min) VALUES (?,?,?)',
    [subject_key, label, credits_per_60min], function (err) {
      if (err) return res.status(500).json({ error: err.message.includes('UNIQUE') ? 'Key already exists' : 'Database error' });
      res.status(201).json({ message: 'Rate created', id: this.lastID });
    });
});

app.put('/api/admin/subject-rates/:id', authenticateToken, isAdmin, (req, res) => {
  const { label, credits_per_60min } = req.body;
  db.run('UPDATE subject_rates SET label = ?, credits_per_60min = ? WHERE id = ?',
    [label, credits_per_60min, req.params.id], function (err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (this.changes === 0) return res.status(404).json({ error: 'Rate not found' });
      res.json({ message: 'Rate updated' });
    });
});

// Credit packs CRUD
app.get('/api/admin/credit-packs', authenticateToken, isAdmin, (req, res) => {
  db.all('SELECT * FROM credit_packs ORDER BY sort_order', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ packs: rows });
  });
});

app.put('/api/admin/credit-packs/:id', authenticateToken, isAdmin, (req, res) => {
  const { name, credits, price_usd, bonus_credits, active } = req.body;
  db.run('UPDATE credit_packs SET name=?, credits=?, price_usd=?, bonus_credits=?, active=? WHERE id=?',
    [name, credits, price_usd, bonus_credits || 0, active !== undefined ? active : 1, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (this.changes === 0) return res.status(404).json({ error: 'Pack not found' });
      res.json({ message: 'Pack updated' });
    });
});

// Start server (0.0.0.0 so it accepts connections when hosted)
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});