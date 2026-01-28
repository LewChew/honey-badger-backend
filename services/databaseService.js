const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

class DatabaseService {
    constructor() {
        this.db = null;
        this.init();
    }

    init() {
        // Create data directory if it doesn't exist
        const dataDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            console.log('📁 Created data directory');
        }

        // Create database file in a data directory
        const dbPath = path.join(dataDir, 'users.db');

        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
            } else {
                console.log('✅ Connected to SQLite database at:', dbPath);
                this.createTables();
            }
        });
    }

    createTables() {
        // Users table
        const createUsersTable = `
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                phone TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT 1,
                email_verified BOOLEAN DEFAULT 0,
                phone_verified BOOLEAN DEFAULT 0
            )
        `;

        // Sessions table for token management
        const createSessionsTable = `
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                token TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `;

        // Gift orders table (linked to users)
        const createGiftOrdersTable = `
            CREATE TABLE IF NOT EXISTS gift_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                tracking_id TEXT UNIQUE NOT NULL,
                recipient_name TEXT NOT NULL,
                recipient_contact TEXT NOT NULL,
                gift_type TEXT NOT NULL,
                gift_value TEXT NOT NULL,
                challenge TEXT,
                message TEXT,
                duration INTEGER,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `;

        // Contacts table (network contacts for each user)
        const createContactsTable = `
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                relationship TEXT,
                birthday TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `;

        // Special dates table (important dates for each contact)
        const createSpecialDatesTable = `
            CREATE TABLE IF NOT EXISTS special_dates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id INTEGER NOT NULL,
                date_name TEXT NOT NULL,
                date_value TEXT NOT NULL,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
            )
        `;

        this.db.run(createUsersTable, (err) => {
            if (err) console.error('Error creating users table:', err.message);
            else console.log('✅ Users table ready');
        });

        this.db.run(createSessionsTable, (err) => {
            if (err) console.error('Error creating sessions table:', err.message);
            else console.log('✅ Sessions table ready');
        });

        this.db.run(createGiftOrdersTable, (err) => {
            if (err) console.error('Error creating gift_orders table:', err.message);
            else console.log('✅ Gift orders table ready');
        });

        this.db.run(createContactsTable, (err) => {
            if (err) console.error('Error creating contacts table:', err.message);
            else console.log('✅ Contacts table ready');
        });

        this.db.run(createSpecialDatesTable, (err) => {
            if (err) console.error('Error creating special_dates table:', err.message);
            else console.log('✅ Special dates table ready');
        });

        // Challenges table (for gift unlock challenges)
        const createChallengesTable = `
            CREATE TABLE IF NOT EXISTS challenges (
                id TEXT PRIMARY KEY,
                gift_id TEXT NOT NULL,
                type TEXT NOT NULL,
                description TEXT,
                requirements TEXT,
                progress TEXT,
                reminder_frequency TEXT,
                last_reminder_sent DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (gift_id) REFERENCES gift_orders(tracking_id)
            )
        `;

        // Photo submissions table (for challenge verification)
        const createPhotoSubmissionsTable = `
            CREATE TABLE IF NOT EXISTS photo_submissions (
                id TEXT PRIMARY KEY,
                challenge_id TEXT NOT NULL,
                gift_id TEXT NOT NULL,
                photo_url TEXT NOT NULL,
                submitter_phone TEXT,
                status TEXT DEFAULT 'pending_approval',
                rejection_reason TEXT,
                submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                reviewed_at DATETIME,
                FOREIGN KEY (challenge_id) REFERENCES challenges(id),
                FOREIGN KEY (gift_id) REFERENCES gift_orders(tracking_id)
            )
        `;

        this.db.run(createChallengesTable, (err) => {
            if (err) console.error('Error creating challenges table:', err.message);
            else console.log('✅ Challenges table ready');
        });

        this.db.run(createPhotoSubmissionsTable, (err) => {
            if (err) console.error('Error creating photo_submissions table:', err.message);
            else console.log('✅ Photo submissions table ready');
        });

        // Run migrations to update existing tables
        this.runMigrations();
    }

    runMigrations() {
        // Check if birthday column exists in contacts table
        this.db.all("PRAGMA table_info(contacts)", (err, columns) => {
            if (err) {
                console.error('Error checking contacts table:', err.message);
                return;
            }

            const hasBirthday = columns && columns.some(col => col.name === 'birthday');

            if (!hasBirthday) {
                console.log('📝 Running migration: Adding birthday column to contacts table');
                this.db.run('ALTER TABLE contacts ADD COLUMN birthday TEXT', (err) => {
                    if (err) {
                        console.error('❌ Migration failed:', err.message);
                    } else {
                        console.log('✅ Migration successful: birthday column added');
                    }
                });
            }
        });

        // Add new columns to gift_orders table
        this.db.all("PRAGMA table_info(gift_orders)", (err, columns) => {
            if (err) {
                console.error('Error checking gift_orders table:', err.message);
                return;
            }

            const columnsToAdd = [
                { name: 'recipient_email', type: 'TEXT' },
                { name: 'recipient_phone', type: 'TEXT' },
                { name: 'delivery_method', type: 'TEXT' },
                { name: 'challenge_type', type: 'TEXT' },
                { name: 'challenge_description', type: 'TEXT' },
                { name: 'verification_type', type: 'TEXT' },
                { name: 'reminder_frequency', type: 'TEXT' },
                { name: 'personal_note', type: 'TEXT' },
                { name: 'notify_on_complete', type: 'BOOLEAN DEFAULT 1' }
            ];

            columnsToAdd.forEach(column => {
                const exists = columns && columns.some(col => col.name === column.name);
                if (!exists) {
                    console.log(`📝 Running migration: Adding ${column.name} column to gift_orders table`);
                    this.db.run(`ALTER TABLE gift_orders ADD COLUMN ${column.name} ${column.type}`, (err) => {
                        if (err) {
                            console.error(`❌ Migration failed for ${column.name}:`, err.message);
                        } else {
                            console.log(`✅ Migration successful: ${column.name} column added`);
                        }
                    });
                }
            });

            // Additional columns for photo unlock workflow
            const photoWorkflowColumns = [
                { name: 'challenge_id', type: 'TEXT' },
                { name: 'unlocked', type: 'BOOLEAN DEFAULT 0' },
                { name: 'photo_submission_url', type: 'TEXT' },
                { name: 'unlocked_at', type: 'DATETIME' }
            ];

            photoWorkflowColumns.forEach(column => {
                const exists = columns && columns.some(col => col.name === column.name);
                if (!exists) {
                    console.log(`📝 Running migration: Adding ${column.name} column to gift_orders table`);
                    this.db.run(`ALTER TABLE gift_orders ADD COLUMN ${column.name} ${column.type}`, (err) => {
                        if (err) {
                            console.error(`❌ Migration failed for ${column.name}:`, err.message);
                        } else {
                            console.log(`✅ Migration successful: ${column.name} column added`);
                        }
                    });
                }
            });
        });

        // Create database indexes for performance
        this.createIndexes();
    }

    createIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_gift_orders_user_id ON gift_orders(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_gift_orders_recipient_email ON gift_orders(recipient_email)',
            'CREATE INDEX IF NOT EXISTS idx_gift_orders_recipient_phone ON gift_orders(recipient_phone)',
            'CREATE INDEX IF NOT EXISTS idx_gift_orders_status ON gift_orders(status)',
            'CREATE INDEX IF NOT EXISTS idx_gift_orders_tracking_id ON gift_orders(tracking_id)',
            'CREATE INDEX IF NOT EXISTS idx_challenges_gift_id ON challenges(gift_id)',
            'CREATE INDEX IF NOT EXISTS idx_photo_submissions_challenge_id ON photo_submissions(challenge_id)',
            'CREATE INDEX IF NOT EXISTS idx_photo_submissions_gift_id ON photo_submissions(gift_id)',
            'CREATE INDEX IF NOT EXISTS idx_photo_submissions_status ON photo_submissions(status)'
        ];

        indexes.forEach(indexSql => {
            this.db.run(indexSql, (err) => {
                if (err) {
                    console.error('❌ Index creation failed:', err.message);
                }
            });
        });
        console.log('✅ Database indexes created');
    }

    // User management methods
    async createUser(userData) {
        const { name, email, password, phone } = userData;
        
        return new Promise((resolve, reject) => {
            // Hash password
            bcrypt.hash(password, 10, (err, hashedPassword) => {
                if (err) {
                    reject(new Error('Password hashing failed'));
                    return;
                }

                const sql = `
                    INSERT INTO users (name, email, password, phone)
                    VALUES (?, ?, ?, ?)
                `;

                this.db.run(sql, [name, email, hashedPassword, phone], function(err) {
                    if (err) {
                        if (err.message.includes('UNIQUE constraint failed')) {
                            reject(new Error('Email already exists'));
                        } else {
                            reject(new Error('Database error: ' + err.message));
                        }
                    } else {
                        resolve({
                            id: this.lastID,
                            name,
                            email,
                            phone: phone || null
                        });
                    }
                });
            });
        });
    }

    async getUserByEmail(email) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM users WHERE email = ? AND is_active = 1`;
            
            this.db.get(sql, [email], (err, row) => {
                if (err) {
                    reject(new Error('Database error: ' + err.message));
                } else {
                    resolve(row);
                }
            });
        });
    }

    async getUserById(id) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT id, name, email, phone, created_at, email_verified, phone_verified FROM users WHERE id = ? AND is_active = 1`;
            
            this.db.get(sql, [id], (err, row) => {
                if (err) {
                    reject(new Error('Database error: ' + err.message));
                } else {
                    resolve(row);
                }
            });
        });
    }

    async verifyPassword(plainPassword, hashedPassword) {
        return new Promise((resolve, reject) => {
            bcrypt.compare(plainPassword, hashedPassword, (err, result) => {
                if (err) {
                    reject(new Error('Password verification failed'));
                } else {
                    resolve(result);
                }
            });
        });
    }

    async updatePassword(email, newPassword) {
        return new Promise((resolve, reject) => {
            // Hash the new password
            bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
                if (err) {
                    reject(new Error('Password hashing failed'));
                    return;
                }

                const sql = `UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`;

                this.db.run(sql, [hashedPassword, email], function(err) {
                    if (err) {
                        reject(new Error('Password update failed: ' + err.message));
                    } else {
                        resolve(this.changes > 0);
                    }
                });
            });
        });
    }

    async updateUserProfile(userId, profileData) {
        const { name } = profileData;

        return new Promise((resolve, reject) => {
            const sql = `UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

            this.db.run(sql, [name, userId], function(err) {
                if (err) {
                    reject(new Error('Profile update failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    async changePasswordById(userId, currentPassword, newPassword) {
        return new Promise(async (resolve, reject) => {
            try {
                // First get the user to verify current password
                const sql = `SELECT password FROM users WHERE id = ? AND is_active = 1`;

                this.db.get(sql, [userId], async (err, row) => {
                    if (err) {
                        reject(new Error('Database error: ' + err.message));
                        return;
                    }

                    if (!row) {
                        reject(new Error('User not found'));
                        return;
                    }

                    // Verify current password
                    const isValid = await bcrypt.compare(currentPassword, row.password);
                    if (!isValid) {
                        reject(new Error('Current password is incorrect'));
                        return;
                    }

                    // Hash the new password
                    bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
                        if (err) {
                            reject(new Error('Password hashing failed'));
                            return;
                        }

                        const updateSql = `UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

                        this.db.run(updateSql, [hashedPassword, userId], function(err) {
                            if (err) {
                                reject(new Error('Password update failed: ' + err.message));
                            } else {
                                resolve(this.changes > 0);
                            }
                        });
                    });
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    // Session management
    async saveSession(userId, token, expiresAt) {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`;
            
            this.db.run(sql, [userId, token, expiresAt], function(err) {
                if (err) {
                    reject(new Error('Session save failed: ' + err.message));
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    async getSession(token) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT s.*, u.id as user_id, u.name, u.email 
                FROM sessions s 
                JOIN users u ON s.user_id = u.id 
                WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1
            `;
            
            this.db.get(sql, [token], (err, row) => {
                if (err) {
                    reject(new Error('Session lookup failed: ' + err.message));
                } else {
                    resolve(row);
                }
            });
        });
    }

    async deleteSession(token) {
        return new Promise((resolve, reject) => {
            const sql = `DELETE FROM sessions WHERE token = ?`;
            
            this.db.run(sql, [token], function(err) {
                if (err) {
                    reject(new Error('Session deletion failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    // Gift order management
    async createGiftOrder(userId, orderData) {
        const {
            trackingId,
            recipientName,
            recipientContact,
            recipientEmail,
            recipientPhone,
            deliveryMethod,
            giftType,
            giftValue,
            challenge,
            challengeType,
            challengeDescription,
            verificationType,
            reminderFrequency,
            personalNote,
            message,
            duration,
            notifyOnComplete
        } = orderData;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO gift_orders (
                    user_id, tracking_id, recipient_name, recipient_contact, recipient_email,
                    recipient_phone, delivery_method, gift_type, gift_value, challenge,
                    challenge_type, challenge_description, verification_type,
                    reminder_frequency, personal_note, message, duration, notify_on_complete
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [
                userId,
                trackingId,
                recipientName,
                recipientContact || recipientPhone || recipientEmail,
                recipientEmail || null,
                recipientPhone || null,
                deliveryMethod || null,
                giftType,
                giftValue,
                challenge || challengeDescription || null,
                challengeType || null,
                challengeDescription || challenge || null,
                verificationType || null,
                reminderFrequency || null,
                personalNote || message || null,
                message || personalNote || null,
                duration || null,
                notifyOnComplete !== undefined ? notifyOnComplete : 1
            ], function(err) {
                if (err) {
                    reject(new Error('Gift order creation failed: ' + err.message));
                } else {
                    resolve({
                        id: this.lastID,
                        trackingId,
                        ...orderData
                    });
                }
            });
        });
    }

    async getUserOrders(userId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT * FROM gift_orders
                WHERE user_id = ?
                ORDER BY created_at DESC
            `;

            this.db.all(sql, [userId], (err, rows) => {
                if (err) {
                    reject(new Error('Orders lookup failed: ' + err.message));
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getReceivedGifts(userEmail, userPhone) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT g.*, u.name as sender_name, u.email as sender_email
                FROM gift_orders g
                LEFT JOIN users u ON g.user_id = u.id
                WHERE g.recipient_email = ? OR g.recipient_phone = ?
                ORDER BY g.created_at DESC
            `;

            this.db.all(sql, [userEmail, userPhone], (err, rows) => {
                if (err) {
                    reject(new Error('Received gifts lookup failed: ' + err.message));
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Cleanup expired sessions
    async cleanupExpiredSessions() {
        return new Promise((resolve, reject) => {
            const sql = `DELETE FROM sessions WHERE expires_at <= datetime('now')`;

            this.db.run(sql, function(err) {
                if (err) {
                    reject(new Error('Session cleanup failed: ' + err.message));
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    // Contact management
    async createContact(userId, contactData) {
        const { name, email, phone, relationship, birthday } = contactData;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO contacts (user_id, name, email, phone, relationship, birthday)
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [userId, name, email || null, phone || null, relationship || null, birthday || null], function(err) {
                if (err) {
                    reject(new Error('Contact creation failed: ' + err.message));
                } else {
                    resolve({
                        id: this.lastID,
                        userId,
                        name,
                        email: email || null,
                        phone: phone || null,
                        relationship: relationship || null,
                        birthday: birthday || null
                    });
                }
            });
        });
    }

    async getUserContacts(userId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, name, email, phone, relationship, birthday, created_at
                FROM contacts
                WHERE user_id = ?
                ORDER BY created_at DESC
            `;

            this.db.all(sql, [userId], (err, rows) => {
                if (err) {
                    reject(new Error('Contacts lookup failed: ' + err.message));
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async deleteContact(userId, contactId) {
        return new Promise((resolve, reject) => {
            const sql = `DELETE FROM contacts WHERE id = ? AND user_id = ?`;

            this.db.run(sql, [contactId, userId], function(err) {
                if (err) {
                    reject(new Error('Contact deletion failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    // Special dates management
    async createSpecialDate(contactId, dateData) {
        const { dateName, dateValue, notes } = dateData;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO special_dates (contact_id, date_name, date_value, notes)
                VALUES (?, ?, ?, ?)
            `;

            this.db.run(sql, [contactId, dateName, dateValue, notes || null], function(err) {
                if (err) {
                    reject(new Error('Special date creation failed: ' + err.message));
                } else {
                    resolve({
                        id: this.lastID,
                        contactId,
                        dateName,
                        dateValue,
                        notes: notes || null
                    });
                }
            });
        });
    }

    async getContactSpecialDates(contactId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, date_name, date_value, notes, created_at
                FROM special_dates
                WHERE contact_id = ?
                ORDER BY date_value ASC
            `;

            this.db.all(sql, [contactId], (err, rows) => {
                if (err) {
                    reject(new Error('Special dates lookup failed: ' + err.message));
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async deleteSpecialDate(specialDateId) {
        return new Promise((resolve, reject) => {
            const sql = `DELETE FROM special_dates WHERE id = ?`;

            this.db.run(sql, [specialDateId], function(err) {
                if (err) {
                    reject(new Error('Special date deletion failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    // Verify contact ownership before special date operations
    async verifyContactOwnership(userId, contactId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT id FROM contacts WHERE id = ? AND user_id = ?`;

            this.db.get(sql, [contactId, userId], (err, row) => {
                if (err) {
                    reject(new Error('Contact verification failed: ' + err.message));
                } else {
                    resolve(!!row);
                }
            });
        });
    }

    // Challenge management methods
    async createChallenge(challengeData) {
        const { id, giftId, type, description, requirements, progress, reminderFrequency } = challengeData;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO challenges (id, gift_id, type, description, requirements, progress, reminder_frequency)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [
                id,
                giftId,
                type,
                description,
                JSON.stringify(requirements || {}),
                JSON.stringify(progress || { started: false, completed: false, currentStep: 0, totalSteps: 1, submissions: [] }),
                reminderFrequency || 'daily'
            ], function(err) {
                if (err) {
                    reject(new Error('Challenge creation failed: ' + err.message));
                } else {
                    resolve({ id, giftId, type, description });
                }
            });
        });
    }

    async getChallengeById(challengeId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM challenges WHERE id = ?`;

            this.db.get(sql, [challengeId], (err, row) => {
                if (err) {
                    reject(new Error('Challenge lookup failed: ' + err.message));
                } else if (row) {
                    row.requirements = JSON.parse(row.requirements || '{}');
                    row.progress = JSON.parse(row.progress || '{}');
                    resolve(row);
                } else {
                    resolve(null);
                }
            });
        });
    }

    async getChallengeByGiftId(giftId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM challenges WHERE gift_id = ?`;

            this.db.get(sql, [giftId], (err, row) => {
                if (err) {
                    reject(new Error('Challenge lookup failed: ' + err.message));
                } else if (row) {
                    row.requirements = JSON.parse(row.requirements || '{}');
                    row.progress = JSON.parse(row.progress || '{}');
                    resolve(row);
                } else {
                    resolve(null);
                }
            });
        });
    }

    async updateChallengeProgress(challengeId, progress) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE challenges SET progress = ? WHERE id = ?`;

            this.db.run(sql, [JSON.stringify(progress), challengeId], function(err) {
                if (err) {
                    reject(new Error('Challenge update failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    async updateChallengeReminderSent(challengeId) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE challenges SET last_reminder_sent = CURRENT_TIMESTAMP WHERE id = ?`;

            this.db.run(sql, [challengeId], function(err) {
                if (err) {
                    reject(new Error('Challenge reminder update failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    // Photo submission methods
    async createPhotoSubmission(submissionData) {
        const { id, challengeId, giftId, photoUrl, submitterPhone, status } = submissionData;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO photo_submissions (id, challenge_id, gift_id, photo_url, submitter_phone, status)
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [
                id,
                challengeId,
                giftId,
                photoUrl,
                submitterPhone || null,
                status || 'pending_approval'
            ], function(err) {
                if (err) {
                    reject(new Error('Photo submission creation failed: ' + err.message));
                } else {
                    resolve({ id, challengeId, giftId, photoUrl, status: status || 'pending_approval' });
                }
            });
        });
    }

    async getPhotoSubmissionById(submissionId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM photo_submissions WHERE id = ?`;

            this.db.get(sql, [submissionId], (err, row) => {
                if (err) {
                    reject(new Error('Photo submission lookup failed: ' + err.message));
                } else {
                    resolve(row);
                }
            });
        });
    }

    async getPhotoSubmissionsByGiftId(giftId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM photo_submissions WHERE gift_id = ? ORDER BY submitted_at DESC`;

            this.db.all(sql, [giftId], (err, rows) => {
                if (err) {
                    reject(new Error('Photo submissions lookup failed: ' + err.message));
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getPendingApprovalsBySenderId(userId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT ps.*, g.recipient_name, g.recipient_email, g.recipient_phone,
                       g.gift_type, g.gift_value, g.tracking_id, c.description as challenge_description
                FROM photo_submissions ps
                JOIN gift_orders g ON ps.gift_id = g.tracking_id
                JOIN challenges c ON ps.challenge_id = c.id
                WHERE g.user_id = ? AND ps.status = 'pending_approval'
                ORDER BY ps.submitted_at DESC
            `;

            this.db.all(sql, [userId], (err, rows) => {
                if (err) {
                    reject(new Error('Pending approvals lookup failed: ' + err.message));
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async updatePhotoSubmissionStatus(submissionId, status, rejectionReason = null) {
        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE photo_submissions
                SET status = ?, rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;

            this.db.run(sql, [status, rejectionReason, submissionId], function(err) {
                if (err) {
                    reject(new Error('Photo submission update failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    // Gift order updates for unlock workflow
    async updateGiftOrderStatus(trackingId, status) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE gift_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE tracking_id = ?`;

            this.db.run(sql, [status, trackingId], function(err) {
                if (err) {
                    reject(new Error('Gift order status update failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    async unlockGiftOrder(trackingId, photoSubmissionUrl = null) {
        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE gift_orders
                SET status = 'completed', unlocked = 1, unlocked_at = CURRENT_TIMESTAMP,
                    photo_submission_url = ?, updated_at = CURRENT_TIMESTAMP
                WHERE tracking_id = ?
            `;

            this.db.run(sql, [photoSubmissionUrl, trackingId], function(err) {
                if (err) {
                    reject(new Error('Gift order unlock failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    async getGiftOrderByTrackingId(trackingId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT g.*, u.name as sender_name, u.email as sender_email, u.phone as sender_phone
                FROM gift_orders g
                LEFT JOIN users u ON g.user_id = u.id
                WHERE g.tracking_id = ?
            `;

            this.db.get(sql, [trackingId], (err, row) => {
                if (err) {
                    reject(new Error('Gift order lookup failed: ' + err.message));
                } else {
                    resolve(row);
                }
            });
        });
    }

    async getGiftOrderByRecipientPhone(phone) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT g.*, u.name as sender_name, u.email as sender_email, u.phone as sender_phone
                FROM gift_orders g
                LEFT JOIN users u ON g.user_id = u.id
                WHERE g.recipient_phone = ? AND g.status != 'completed'
                ORDER BY g.created_at DESC
                LIMIT 1
            `;

            this.db.get(sql, [phone], (err, row) => {
                if (err) {
                    reject(new Error('Gift order lookup failed: ' + err.message));
                } else {
                    resolve(row);
                }
            });
        });
    }

    async getActiveGiftsByRecipientPhone(phone) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT g.*, u.name as sender_name, u.email as sender_email
                FROM gift_orders g
                LEFT JOIN users u ON g.user_id = u.id
                WHERE g.recipient_phone = ? AND g.status != 'completed'
                ORDER BY g.created_at DESC
            `;

            this.db.all(sql, [phone], (err, rows) => {
                if (err) {
                    reject(new Error('Active gifts lookup failed: ' + err.message));
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async linkChallengeToGiftOrder(trackingId, challengeId) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE gift_orders SET challenge_id = ? WHERE tracking_id = ?`;

            this.db.run(sql, [challengeId, trackingId], function(err) {
                if (err) {
                    reject(new Error('Challenge link failed: ' + err.message));
                } else {
                    resolve(this.changes > 0);
                }
            });
        });
    }

    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err.message);
                } else {
                    console.log('Database connection closed');
                }
            });
        }
    }
}

module.exports = new DatabaseService();
