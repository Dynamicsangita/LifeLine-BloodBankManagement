import 'dotenv/config';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import MongoStore from 'connect-mongo';
import ejs from 'ejs';
import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import mongoose from 'mongoose';
import {
  BloodBank,
  BloodRequest,
  BloodStock,
  ContactMessage,
  Donation,
  Donor,
  User,
} from './models.js';
import { BLOOD_GROUPS, COMPATIBLE_DONORS, escapeRegex } from './lib/blood.js';
import { isSupportedDonorPhoto } from './lib/donor-photo.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const donorPhotoDirectory = path.join(__dirname, 'uploads', 'donors');
const port = Number(process.env.PORT || 3000);
const configuredMongoUri = process.env.MONGODB_URI;
const configuredSessionSecret = process.env.SESSION_SECRET || process.env.SECRET_KEY;
const configuredTrustProxyHops = process.env.TRUST_PROXY_HOPS;
const isProduction = process.env.NODE_ENV === 'production';
const directoryConsentPolicyVersion = '1.0';

if (configuredTrustProxyHops && !/^\d+$/.test(configuredTrustProxyHops)) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
}
if (isProduction && !configuredMongoUri) {
  throw new Error('Set MONGODB_URI to the production database connection string.');
}
if (isProduction && (!configuredSessionSecret || configuredSessionSecret.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in .env.');
}
if (!configuredSessionSecret) {
  console.warn('No SESSION_SECRET configured; using a temporary local-development session secret.');
}
const sessionSecret = configuredSessionSecret?.length >= 32
  ? configuredSessionSecret
  : configuredSessionSecret
    ? createHash('sha256').update(configuredSessionSecret).digest('hex')
    : randomBytes(32).toString('hex');
const mongoUri = configuredMongoUri || 'mongodb://127.0.0.1:27017/lifeline';

const app = express();
if (configuredTrustProxyHops) app.set('trust proxy', Number(configuredTrustProxyHops));
mongoose.set('strictQuery', false);

async function migrateUnverifiableDonorConsent() {
  return Donor.updateMany(
    { directoryConsentStatus: { $exists: false } },
    {
      $set: {
        directoryConsent: false,
        directoryConsentStatus: 'unknown',
        directoryConsentUpdatedAt: null,
        photoConsent: false,
        photoConsentStatus: 'unknown',
        photoConsentUpdatedAt: null,
        available: false,
      },
    },
  );
}

async function migrateLegacyAccountStatus() {
  return User.updateMany(
    { accountStatus: { $exists: false } },
    { $set: { accountStatus: 'active', deletionRequestedAt: null, deletionReviewedAt: null, deletionReviewedBy: null } },
  );
}

const mongoClientPromise = process.env.NODE_ENV === 'test'
  ? null
  : mongoose.connect(mongoUri).then(async () => {
    const topology = await mongoose.connection.db.admin().command({ ismaster: 1 });
    if (isProduction && !topology.setName) {
      throw new Error('Production MongoDB must be configured as a replica set to support transactions.');
    }
    await Promise.all([
      migrateLegacyAccountStatus(),
      ...BLOOD_GROUPS.map((bloodGroup) =>
        BloodStock.updateOne({ bloodGroup }, { $setOnInsert: { units: 0 } }, { upsert: true })),
      migrateUnverifiableDonorConsent(),
    ]);
    return mongoose.connection.getClient();
  });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.compatibleDonors = COMPATIBLE_DONORS;
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      frameSrc: ['https://maps.google.com'],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      styleSrcAttr: ["'unsafe-inline'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'static')));
const sessionOptions = {
  name: 'lifeline.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
};
let sessionMiddleware = process.env.NODE_ENV === 'production'
  ? null
  : session({
    ...sessionOptions,
    store: new session.MemoryStore(),
  });
app.use((req, res, next) => {
  if (!sessionMiddleware) return next(new Error('The persistent session store is not ready.'));
  return sessionMiddleware(req, res, next);
});

app.use((req, res, next) => {
  if (!req.session.user) return next();
  User.findById(req.session.user.id).select('accountStatus role fullName').lean()
    .then((user) => {
      if (user?.accountStatus === 'active') {
        req.session.user.role = user.role;
        req.session.user.name = user.fullName;
        return next();
      }
      return req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie('lifeline.sid', {
          httpOnly: true,
          sameSite: 'lax',
          secure: isProduction,
        });
        return res.redirect('/login');
      });
    })
    .catch(next);
});

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
  res.locals.currentUser = req.session.user || null;
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.bloodGroups = BLOOD_GROUPS;
  res.locals.currentYear = new Date().getFullYear();
  res.locals.flashMessages = req.session.flashMessages || [];
  delete req.session.flashMessages;
  next();
});

const publicSubmissionPaths = new Set(['/donor/register', '/blood-banks/suggest', '/contact']);
const createPublicSubmissionLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const publicSubmissionLimiters = new Map(
  [...publicSubmissionPaths].map((route) => [route, createPublicSubmissionLimiter()]),
);
app.use((req, res, next) => {
  const limiter = req.method === 'POST' ? publicSubmissionLimiters.get(req.path) : null;
  return limiter ? limiter(req, res, next) : next();
});

const donorPhotoExtensions = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const donorPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      mkdir(donorPhotoDirectory, { recursive: true })
        .then(() => callback(null, donorPhotoDirectory))
        .catch(callback);
    },
    filename: (_req, file, callback) => {
      callback(null, `${randomBytes(16).toString('hex')}.${donorPhotoExtensions.get(file.mimetype)}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (_req, file, callback) => {
    if (!donorPhotoExtensions.has(file.mimetype)) {
      return callback(new Error('Choose a JPEG, PNG, or WebP profile photo.'));
    }
    callback(null, true);
  },
});

async function removeDonorPhoto(filename) {
  if (!/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(filename || '')) return;
  try {
    await unlink(path.join(donorPhotoDirectory, filename));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/donor/register'
      || !req.is('multipart/form-data')) return next();
  donorPhotoUpload.single('photo')(req, res, (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Profile photos must be 5 MB or smaller.'
        : error instanceof multer.MulterError
          ? 'Choose one JPEG, PNG, or WebP profile photo.'
          : error.message === 'Choose a JPEG, PNG, or WebP profile photo.'
            ? error.message
            : 'Unable to process the profile photo. Please try again.';
      flash(req, 'danger', message);
      return res.redirect('/donor/register');
    }
    if (!req.file) return next();
    readFile(req.file.path)
      .then(async (buffer) => {
        if (isSupportedDonorPhoto(buffer, req.file.mimetype)) return next();
        await removeDonorPhoto(req.file.filename);
        req.file = undefined;
        flash(req, 'danger', 'The selected file is not a valid JPEG, PNG, or WebP image.');
        return res.redirect('/donor/register');
      })
      .catch(next);
  });
});

app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const token = req.body.csrfToken;
  if (typeof token !== 'string' || token !== req.session.csrfToken) {
    if (req.file) removeDonorPhoto(req.file.filename).catch(logServerError);
    return res.status(403).render('error', {
      title: 'Request expired',
      message: 'This form expired or could not be verified. Please refresh the page and try again.',
    });
  }
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

function flash(req, type, message) {
  req.session.flashMessages = [...(req.session.flashMessages || []), { type, message }];
}

function isDuplicateDonorPhoneError(error) {
  return error?.code === 11000
    && (error.keyPattern?.phone === 1 || error.keyValue?.phone !== undefined);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

class MongoReplicaSetRequiredError extends Error {
  constructor() {
    super('MongoDB replica set transactions are required for this operation.');
    this.name = 'MongoReplicaSetRequiredError';
  }
}

class InsufficientStockError extends Error {
  constructor() {
    super('There is not enough recorded inventory to fulfill this request.');
    this.name = 'InsufficientStockError';
  }
}

async function withMongoTransaction(operation) {
  const topology = await mongoose.connection.db.admin().command({ ismaster: 1 });
  if (!topology.setName) throw new MongoReplicaSetRequiredError();
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function logServerError(error) {
  const details = error instanceof Error ? error.stack || error.message : String(error);
  console.error(details.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[MongoDB URI]'));
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    flash(req, 'warning', 'Please log in to continue.');
    return res.redirect('/login');
  }
  return next();
}

async function requireAdmin(req, res, next) {
  const user = await User.findById(req.session.user.id).select('role').lean();
  if (!user) {
    return req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('lifeline.sid');
      return res.redirect('/login');
    });
  }
  req.session.user.role = user.role;
  if (user.role !== 'admin') {
    flash(req, 'danger', 'Administrator access is required.');
    return res.redirect('/dashboard');
  }
  return next();
}

function renderPage(res, view, locals = {}) {
  return res.render(view, { ...locals });
}

async function orderedStock() {
  const records = await BloodStock.find().lean();
  const byGroup = new Map(records.map((record) => [record.bloodGroup, record]));
  return BLOOD_GROUPS.map((bloodGroup) => byGroup.get(bloodGroup) || { bloodGroup, units: 0 });
}

function csvCell(value) {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
  const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function isValidPhone(value) {
  const digits = value.replace(/\D/g, '');
  return /^[+\d().\-\s]+$/.test(value) && digits.length >= 7 && digits.length <= 15;
}

app.get('/', asyncRoute(async (req, res) => {
  const [totalDonors, totalRequests, stock] = await Promise.all([
    Donor.countDocuments({
      available: true,
      directoryConsent: true,
      directoryConsentStatus: 'consented',
    }),
    BloodRequest.countDocuments(),
    orderedStock(),
  ]);
  renderPage(res, 'home', {
    totalDonors,
    totalRequests,
    totalUnits: stock.reduce((total, item) => total + item.units, 0),
    inventory: stock,
  });
}));

app.get('/about', (req, res) => renderPage(res, 'about'));
app.get('/how-it-works', (req, res) => renderPage(res, 'how-it-works', {
  compatibleDonors: COMPATIBLE_DONORS,
}));
app.get('/privacy', (req, res) => renderPage(res, 'privacy'));
app.get('/terms', (req, res) => renderPage(res, 'terms'));

app.get('/donors', asyncRoute(async (req, res) => {
  const rawBloodGroup = String(req.query.bloodGroup || '').trim();
  const bloodGroup = rawBloodGroup && BLOOD_GROUPS.includes(rawBloodGroup) ? rawBloodGroup : '';
  const city = String(req.query.city || '').trim().slice(0, 100);
  const rawMinAge = String(req.query.minAge || '').trim();
  const rawMaxAge = String(req.query.maxAge || '').trim();
  const minAge = rawMinAge ? Number(rawMinAge) : null;
  const maxAge = rawMaxAge ? Number(rawMaxAge) : null;
  const gender = String(req.query.gender || '').trim();
  const supportedGenders = ['Female', 'Male', 'Other', 'Prefer not to say'];
  if ((rawBloodGroup && !bloodGroup)
      || (rawMinAge && (!Number.isInteger(minAge) || minAge < 18 || minAge > 65))
      || (rawMaxAge && (!Number.isInteger(maxAge) || maxAge < 18 || maxAge > 65))
      || (minAge !== null && maxAge !== null && minAge > maxAge)
      || (gender && !supportedGenders.includes(gender))) {
    flash(req, 'danger', 'Choose a valid blood group, gender and age range (18–65).');
    return res.redirect('/donors');
  }
  const searchActive = true;
  const filter = { available: true, directoryConsent: true, directoryConsentStatus: 'consented' };
  if (bloodGroup) filter.bloodGroup = bloodGroup;
  if (city) filter.city = new RegExp(escapeRegex(city), 'i');
  if (gender) filter.gender = gender;
  if (minAge !== null || maxAge !== null) {
    filter.age = {
      ...(minAge !== null ? { $gte: minAge } : {}),
      ...(maxAge !== null ? { $lte: maxAge } : {}),
    };
  }
  const donors = await Donor.find(filter).populate('user', 'fullName phone').sort({ createdAt: -1 }).lean();
  renderPage(res, 'find-donors', {
    donors, selectedGroup: bloodGroup, city, minAge: rawMinAge, maxAge: rawMaxAge, gender, searchActive,
  });
}));

app.get('/donor-photos/:filename', asyncRoute(async (req, res) => {
  if (!/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(req.params.filename)) return res.sendStatus(404);
  const photoPath = `/donor-photos/${req.params.filename}`;
  const donor = await Donor.exists({
    photoPath,
    photoConsent: true,
    photoConsentStatus: 'consented',
    available: true,
    directoryConsent: true,
    directoryConsentStatus: 'consented',
  });
  if (!donor) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store');
  return res.sendFile(path.join(donorPhotoDirectory, req.params.filename));
}));

app.get('/donor/register', asyncRoute(async (req, res) => {
  const donor = req.session.user
    ? await Donor.findOne({ user: req.session.user.id }).lean()
    : null;
  const account = req.session.user
    ? await User.findById(req.session.user.id).select('fullName phone').lean()
    : null;
  renderPage(res, 'donor-register', { donor, account });
}));

app.post('/donor/register', asyncRoute(async (req, res) => {
  const age = Number(req.body.age);
  const bloodGroup = String(req.body.bloodGroup || '');
  const city = String(req.body.city || '').trim();
  const account = req.session.user
    ? await User.findById(req.session.user.id).select('fullName phone').lean()
    : null;
  const existingDonor = req.session.user
    ? await Donor.findOne({ user: req.session.user.id }).lean()
    : null;
  const fullName = String(req.body.fullName || account?.fullName || '').trim();
  const phone = String(req.body.phone || account?.phone || '').trim();
  const lastDonationDate = req.body.lastDonationDate ? new Date(req.body.lastDonationDate) : null;
  const gender = String(req.body.gender || 'Prefer not to say');
  if (!fullName || fullName.length > 100 || phone.length > 20 || !isValidPhone(phone)
      || !Number.isInteger(age) || age < 18 || age > 65 || !BLOOD_GROUPS.includes(bloodGroup)
      || !['Prefer not to say', 'Female', 'Male', 'Other'].includes(gender)
      || !city || city.length > 100 || (lastDonationDate && Number.isNaN(lastDonationDate.getTime()))
      || (lastDonationDate && lastDonationDate > new Date())) {
    if (req.file) await removeDonorPhoto(req.file.filename);
    flash(req, 'danger', 'Please check age, blood group, city and last donation date.');
    return res.redirect('/donor/register');
  }
  const available = Array.isArray(req.body.available)
    ? req.body.available.includes('on')
    : req.body.available !== 'off';
  const directoryConsent = req.body.directoryConsent === 'on';
  const consentUpdatedAt = new Date();
  const directoryConsentStatus = directoryConsent
    ? 'consented'
    : existingDonor?.directoryConsentStatus === 'consented' ? 'withdrawn' : 'unknown';
  const photoConsent = req.body.photoConsent === 'on'
    && Boolean(req.file || existingDonor?.photoPath);
  const photoConsentStatus = photoConsent
    ? 'consented'
    : existingDonor?.photoConsentStatus === 'consented' ? 'withdrawn' : 'unknown';
  if (!req.session.user && !directoryConsent) {
    if (req.file) await removeDonorPhoto(req.file.filename);
    flash(req, 'danger', 'Please consent to public donor-directory visibility before registering.');
    return res.redirect('/donor/register');
  }
  if (req.file && req.body.photoConsent !== 'on') {
    await removeDonorPhoto(req.file.filename);
    flash(req, 'danger', 'Please confirm that you consent to display your uploaded photo in donor search.');
    return res.redirect('/donor/register');
  }
  const phoneConflictFilter = { phone };
  if (req.session.user) phoneConflictFilter.user = { $ne: req.session.user.id };
  if (await Donor.exists(phoneConflictFilter)) {
    if (req.file) await removeDonorPhoto(req.file.filename);
    flash(req, 'danger', 'This phone number is already registered as a donor. Please use a different number.');
    return res.redirect('/donor/register');
  }
  const photoPath = req.file
    ? `/donor-photos/${req.file.filename}`
    : req.body.photoConsent === 'on' && req.body.removePhoto !== 'on'
      ? existingDonor?.photoPath || null
      : null;
  const donorDetails = {
    fullName,
    phone,
    bloodGroup,
    age,
    gender,
    city,
    address: String(req.body.address || '').trim().slice(0, 255),
    lastDonationDate,
    directoryConsent,
    directoryConsentStatus,
    directoryConsentUpdatedAt: directoryConsent || directoryConsentStatus === 'withdrawn'
      ? consentUpdatedAt
      : existingDonor?.directoryConsentUpdatedAt || null,
    directoryConsentPolicyVersion: directoryConsent
      ? directoryConsentPolicyVersion
      : existingDonor?.directoryConsentPolicyVersion || null,
    photoPath,
    photoConsent: Boolean(photoPath && photoConsent),
    photoConsentStatus,
    photoConsentUpdatedAt: photoConsent || photoConsentStatus === 'withdrawn'
      ? consentUpdatedAt
      : existingDonor?.photoConsentUpdatedAt || null,
    available: available && directoryConsent,
  };
  if (req.session.user) {
    try {
      await Donor.findOneAndUpdate(
        { user: req.session.user.id },
        { ...donorDetails, user: req.session.user.id },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (req.file) await removeDonorPhoto(req.file.filename);
      if (!isDuplicateDonorPhoneError(error)) throw error;
      flash(req, 'danger', 'This phone number is already registered as a donor. Please use a different number.');
      return res.redirect('/donor/register');
    }
    if (existingDonor?.photoPath && existingDonor.photoPath !== photoPath) {
      const previousFilename = path.basename(existingDonor.photoPath);
      await removeDonorPhoto(previousFilename).catch(logServerError);
    }
    flash(req, 'success', donorDetails.available
      ? 'Donor profile saved.'
      : 'Donor profile saved. Your public listing is paused until you are available and have given directory consent.');
    return res.redirect('/dashboard');
  }
  try {
    await Donor.create(donorDetails);
  } catch (error) {
    if (req.file) await removeDonorPhoto(req.file.filename);
    if (!isDuplicateDonorPhoneError(error)) throw error;
    flash(req, 'danger', 'This phone number is already registered as a donor. Please use a different number.');
    return res.redirect('/donor/register');
  }
  flash(req, 'success', 'Thank you for registering as a donor. You can now be found by people searching in your area.');
  res.redirect('/donors?bloodGroup=' + encodeURIComponent(bloodGroup) + '&city=' + encodeURIComponent(city));
}));

app.get('/signup', (req, res) => renderPage(res, 'signup'));
app.get('/register', (req, res) => res.redirect('/signup'));
app.post('/signup', authLimiter, asyncRoute(async (req, res) => {
  const fullName = String(req.body.fullName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  if (!fullName || fullName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || email.length > 120 || phone.length > 20 || !isValidPhone(phone) || password.length < 8
      || password.length > 128 || password !== confirmPassword) {
    flash(req, 'danger', 'Enter valid name, email and phone details. Passwords must match and be 8–128 characters.');
    return res.redirect('/signup');
  }
  try {
    await User.create({
      fullName,
      email,
      phone,
      passwordHash: await bcrypt.hash(password, 12),
    });
  } catch (error) {
    if (error?.code === 11000) {
      flash(req, 'warning', 'This email is already registered. Please log in.');
      return res.redirect('/login');
    }
    throw error;
  }
  flash(req, 'success', 'Account created. Please log in.');
  res.redirect('/login');
}));

app.get('/login', (req, res) => renderPage(res, 'login'));
app.post('/login', authLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await User.findOne({ email }).lean();
  if (!user || user.accountStatus !== 'active'
      || !(await bcrypt.compare(password, user.passwordHash))) {
    flash(req, 'danger', 'Invalid email or password.');
    return res.redirect('/login');
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).render('error', { title: 'Login error', message: 'Unable to start your session. Please try again.' });
    req.session.user = { id: String(user._id), name: user.fullName, role: user.role };
    req.session.csrfToken = randomBytes(32).toString('hex');
    req.session.cookie.maxAge = req.body.remember === 'on' ? 1000 * 60 * 60 * 24 * 7 : null;
    req.session.flashMessages = [{ type: 'success', message: `Welcome, ${user.fullName}!` }];
    res.redirect('/dashboard');
  });
}));

app.post('/logout', requireLogin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('lifeline.sid');
    res.redirect('/');
  });
});

app.post('/account/deletion-request', requireLogin, asyncRoute(async (req, res) => {
  const password = String(req.body.password || '');
  const user = await User.findById(req.session.user.id).select('passwordHash role accountStatus').lean();
  if (!password || password.length > 128 || !user || user.accountStatus !== 'active'
      || !(await bcrypt.compare(password, user.passwordHash))) {
    flash(req, 'danger', 'Enter your current password to confirm this request.');
    return res.redirect('/dashboard#account-privacy');
  }
  if (user.role === 'admin'
      && await User.countDocuments({ role: 'admin', accountStatus: 'active' }) <= 1) {
    flash(req, 'danger', 'The last active administrator cannot be deactivated. Assign another administrator first.');
    return res.redirect('/dashboard#account-privacy');
  }

  const now = new Date();
  try {
    await withMongoTransaction(async (session) => {
      const result = await User.updateOne(
        { _id: user._id, accountStatus: 'active' },
        {
          $set: {
            accountStatus: 'deletion_requested',
            deletionRequestedAt: now,
            deletionReviewedAt: null,
            deletionReviewedBy: null,
          },
        },
        { session },
      );
      if (result.modifiedCount !== 1) throw new Error('Account status changed before the request was saved.');
      await Donor.updateOne(
        { user: user._id },
        {
          $set: {
            available: false,
            directoryConsent: false,
            directoryConsentStatus: 'withdrawn',
            directoryConsentUpdatedAt: now,
            photoConsent: false,
            photoConsentStatus: 'withdrawn',
            photoConsentUpdatedAt: now,
          },
        },
        { session },
      );
    });
  } catch (error) {
    if (error instanceof MongoReplicaSetRequiredError) {
      flash(req, 'danger', 'Account deactivation requires MongoDB to run as a replica set. No account data was changed.');
      return res.redirect('/dashboard#account-privacy');
    }
    throw error;
  }

  req.session.destroy((error) => {
    if (error) return res.status(500).render('error', {
      title: 'Sign-out error',
      message: 'Your account has been deactivated, but this session could not be closed. Close the browser and contact LifeLine support.',
    });
    res.clearCookie('lifeline.sid');
    return res.redirect('/login');
  });
}));

app.get('/request-blood', (req, res) => renderPage(res, 'request-blood', {
  canSubmit: Boolean(req.session.user),
}));
app.post('/request-blood', requireLogin, asyncRoute(async (req, res) => {
  const units = Number(req.body.units);
  const bloodGroup = String(req.body.bloodGroup || '');
  const urgency = String(req.body.urgency || 'Normal');
  const fields = ['patientName', 'hospital', 'city', 'contactPhone'];
  const formValues = Object.fromEntries(fields.map((field) => [field, String(req.body[field] || '').trim()]));
  const message = String(req.body.message || '').trim();
  const fieldLimits = { patientName: 100, hospital: 150, city: 100, contactPhone: 20 };
  if (!BLOOD_GROUPS.includes(bloodGroup) || !Number.isInteger(units) || units < 1 || units > 20
      || !['Normal', 'Urgent', 'Emergency'].includes(urgency)
      || fields.some((field) => !formValues[field] || formValues[field].length > fieldLimits[field])
      || !isValidPhone(formValues.contactPhone)
      || message.length > 500) {
    flash(req, 'danger', 'Check all request details. Units must be between 1 and 20.');
    return res.redirect('/request-blood');
  }
  try {
    await withMongoTransaction((session) => BloodRequest.create([{
      user: req.session.user.id,
      ...formValues,
      bloodGroup,
      units,
      urgency,
      message,
    }], { session }));
  } catch (error) {
    if (error instanceof MongoReplicaSetRequiredError) {
      flash(req, 'danger', 'Submitting requests requires MongoDB to run as a replica set. No request was saved.');
      return res.redirect('/request-blood');
    }
    throw error;
  }
  flash(req, 'success', 'Blood request submitted for review.');
  res.redirect('/dashboard');
}));

app.post('/request-blood/:id/cancel', requireLogin, asyncRoute(async (req, res) => {
  const result = await BloodRequest.updateOne(
    { _id: req.params.id, user: req.session.user.id, status: 'Pending' },
    { $set: { status: 'Cancelled' } },
  );
  flash(req, result.modifiedCount ? 'success' : 'warning',
    result.modifiedCount ? 'Request cancelled.' : 'This request could not be cancelled.');
  res.redirect('/dashboard');
}));

app.get('/emergency-match', asyncRoute(async (req, res) => {
  const bloodGroup = BLOOD_GROUPS.includes(req.query.bloodGroup) ? req.query.bloodGroup : '';
  const city = String(req.query.city || '').trim().slice(0, 100);
  let donors = [];
  if (bloodGroup) {
    const filter = {
      bloodGroup: { $in: COMPATIBLE_DONORS[bloodGroup] },
      available: true,
      directoryConsent: true,
      directoryConsentStatus: 'consented',
    };
    if (city) filter.city = new RegExp(escapeRegex(city), 'i');
    donors = await Donor.find(filter).populate('user', 'fullName phone').sort({ bloodGroup: 1 }).lean();
  }
  renderPage(res, 'emergency-match', {
    donors,
    selectedGroup: bloodGroup,
    city,
    compatibleGroups: COMPATIBLE_DONORS[bloodGroup] || [],
  });
}));

app.get('/blood-banks', asyncRoute(async (req, res) => {
  const city = String(req.query.city || '').trim().slice(0, 100);
  const bloodGroup = BLOOD_GROUPS.includes(req.query.bloodGroup) ? req.query.bloodGroup : '';
  const filter = { verified: true };
  if (city) filter.city = new RegExp(escapeRegex(city), 'i');
  if (bloodGroup) filter.bloodGroups = bloodGroup;
  const banks = await BloodBank.find(filter).sort({ city: 1, name: 1 }).lean();
  renderPage(res, 'blood-banks', { banks, city, selectedGroup: bloodGroup });
}));

app.post('/blood-banks/suggest', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const address = String(req.body.address || '').trim();
  const city = String(req.body.city || '').trim();
  const phone = String(req.body.phone || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const openingHours = String(req.body.openingHours || '').trim();
  const rawBloodGroups = req.body.bloodGroups;
  const bloodGroups = Array.isArray(rawBloodGroups)
    ? rawBloodGroups
    : rawBloodGroups ? [rawBloodGroups] : [];
  const phoneDigits = phone.replace(/\D/g, '');
  if (!name || name.length > 150 || !address || address.length > 255
      || !city || city.length > 100 || phone.length > 20
      || !/^[+\d().\-\s]+$/.test(phone) || phoneDigits.length < 7 || phoneDigits.length > 15
      || (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120))
      || openingHours.length > 200 || bloodGroups.some((group) => !BLOOD_GROUPS.includes(group))) {
    flash(req, 'danger', 'Please enter valid blood bank details before submitting.');
    return res.redirect('/blood-banks#register-bank');
  }
  await BloodBank.create({
    name,
    address,
    city,
    phone,
    email,
    openingHours,
    bloodGroups,
    verified: false,
  });
  flash(req, 'success', 'Thank you. Your blood bank submission is pending administrator verification.');
  res.redirect('/blood-banks#directory');
}));

app.get('/contact', (req, res) => renderPage(res, 'contact'));
app.post('/contact', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || email.length > 120 || !subject || subject.length > 150 || !message || message.length > 2000) {
    flash(req, 'danger', 'Please complete all contact fields with valid details.');
    return res.redirect('/contact');
  }
  await ContactMessage.create({ name, email, subject, message });
  flash(req, 'success', 'Thanks for contacting LifeLine. Your message has been received.');
  res.redirect('/contact');
}));

app.get('/dashboard', requireLogin, asyncRoute(async (req, res) => {
  const [user, donor, requests, donations] = await Promise.all([
    User.findById(req.session.user.id).select('fullName email phone').lean(),
    Donor.findOne({ user: req.session.user.id }).lean(),
    BloodRequest.find({ user: req.session.user.id }).sort({ createdAt: -1 }).lean(),
    Donation.find({ user: req.session.user.id }).sort({ donationDate: -1 }).lean(),
  ]);
  const notifications = requests.slice(0, 5).map((request) => ({
    icon: request.status === 'Fulfilled' ? '✓' : request.status === 'Rejected' ? '!' : '✚',
    title: `${request.bloodGroup} blood request ${request.status.toLowerCase()}`,
    message: request.status === 'Pending'
      ? 'Your request is waiting for review by the LifeLine team.'
      : `The request for ${request.patientName} is now ${request.status.toLowerCase()}.`,
    href: '#requests',
  }));
  if (!donor) {
    notifications.unshift({
      icon: '♥',
      title: 'Complete your donor profile',
      message: 'Add your blood group and city if you would like to appear in donor searches.',
      href: '/donor/register',
    });
  } else if (!donor.available) {
    notifications.unshift({
      icon: '◷',
      title: 'Donor availability is paused',
      message: 'Update your profile whenever you are ready to be contacted again.',
      href: '/donor/register',
    });
  }
  renderPage(res, 'dashboard', { account: user, donor, requests, donations, notifications: notifications.slice(0, 5) });
}));

app.post('/donations', requireLogin, asyncRoute(async (req, res) => {
  const donationDate = new Date(String(req.body.donationDate || ''));
  const center = String(req.body.center || '').trim();
  const notes = String(req.body.notes || '').trim();
  if (Number.isNaN(donationDate.getTime()) || donationDate > new Date()
      || donationDate < new Date('1900-01-01') || center.length > 150 || notes.length > 300) {
    flash(req, 'danger', 'Enter a valid donation date and center.');
    return res.redirect('/dashboard');
  }
  await Donation.create({
    user: req.session.user.id,
    donationDate,
    center,
    notes,
  });
  await Donor.updateOne(
    { user: req.session.user.id },
    { $max: { lastDonationDate: donationDate } },
  );
  flash(req, 'success', 'Donation history entry saved.');
  res.redirect('/dashboard');
}));

app.use('/admin', requireLogin, requireAdmin);

app.get('/admin', asyncRoute(async (req, res) => {
  const [
    requests,
    inventory,
    donorCount,
    messages,
    requestCount,
    pendingRequestCount,
    fulfilledRequestCount,
    pendingBanks,
    donorGroupCounts,
    recentDonors,
    recentRequests,
    recentMessages,
    pendingDeletionRequests,
  ] = await Promise.all([
    BloodRequest.find().populate('user', 'fullName').sort({ createdAt: -1 }).limit(200).lean(),
    orderedStock(),
    Donor.countDocuments(),
    ContactMessage.find().sort({ createdAt: -1 }).limit(50).lean(),
    BloodRequest.countDocuments(),
    BloodRequest.countDocuments({ status: 'Pending' }),
    BloodRequest.countDocuments({ status: 'Fulfilled' }),
    BloodBank.find({ verified: false }).sort({ createdAt: 1 }).limit(100).lean(),
    Donor.aggregate([{ $group: { _id: '$bloodGroup', count: { $sum: 1 } } }]),
    Donor.find().select('fullName bloodGroup city createdAt available directoryConsentStatus').sort({ createdAt: -1 }).limit(6).lean(),
    BloodRequest.find().select('patientName bloodGroup status urgency createdAt').sort({ createdAt: -1 }).limit(6).lean(),
    ContactMessage.find().select('name subject createdAt').sort({ createdAt: -1 }).limit(6).lean(),
    User.find({ accountStatus: 'deletion_requested', deletionReviewedAt: null })
      .select('fullName email deletionRequestedAt')
      .sort({ deletionRequestedAt: 1 })
      .limit(100)
      .lean(),
  ]);
  const donorCountsByGroup = new Map(donorGroupCounts.map(({ _id, count }) => [_id, count]));
  const bloodGroupStats = BLOOD_GROUPS.map((bloodGroup) => ({
    bloodGroup,
    count: donorCountsByGroup.get(bloodGroup) || 0,
  }));
  const recentActivity = [
    ...recentDonors.map((donor) => ({
      type: 'donor',
      title: `${donor.fullName} joined as a donor`,
      detail: `${donor.bloodGroup} · ${donor.city}`,
      createdAt: donor.createdAt,
    })),
    ...recentRequests.map((request) => ({
      type: 'request',
      title: `${request.urgency} blood request`,
      detail: `${request.bloodGroup} · ${request.patientName} · ${request.status}`,
      createdAt: request.createdAt,
    })),
    ...recentMessages.map((message) => ({
      type: 'message',
      title: `New enquiry from ${message.name}`,
      detail: message.subject,
      createdAt: message.createdAt,
    })),
  ].sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt)).slice(0, 8);
  renderPage(res, 'admin', {
    requests,
    inventory,
    donorCount,
    messages,
    requestCount,
    pendingRequestCount,
    fulfilledRequestCount,
    pendingBanks,
    bloodGroupStats,
    recentDonors,
    recentActivity,
    pendingDeletionRequests,
  });
}));

app.get('/admin/reports/requests.csv', asyncRoute(async (req, res) => {
  const requests = await BloodRequest.find()
    .select('patientName bloodGroup units hospital city urgency status createdAt')
    .sort({ createdAt: -1 })
    .limit(5000)
    .lean();
  const rows = [
    ['Patient', 'Blood group', 'Units', 'Hospital', 'City', 'Urgency', 'Status', 'Created at'],
    ...requests.map((request) => [
      request.patientName,
      request.bloodGroup,
      request.units,
      request.hospital,
      request.city,
      request.urgency,
      request.status,
      request.createdAt,
    ]),
  ];
  res.type('text/csv; charset=utf-8');
  res.attachment('lifeline-blood-requests.csv');
  res.send(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
}));

app.post('/admin/inventory', asyncRoute(async (req, res) => {
  const rawUnits = String(req.body.units ?? '');
  const units = /^\d+$/.test(rawUnits) ? Number(rawUnits) : NaN;
  const bloodGroup = String(req.body.bloodGroup || '');
  if (!BLOOD_GROUPS.includes(bloodGroup) || !Number.isInteger(units) || units < 0 || units > 100000) {
    flash(req, 'danger', 'Enter a valid blood group and inventory count.');
    return res.redirect('/admin');
  }
  await BloodStock.findOneAndUpdate(
    { bloodGroup },
    { $set: { units, updatedBy: req.session.user.id } },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  flash(req, 'success', `${bloodGroup} inventory updated.`);
  res.redirect('/admin');
}));

app.post('/admin/blood-bank/:id/:action', asyncRoute(async (req, res) => {
  if (!['verify', 'reject'].includes(req.params.action)) {
    flash(req, 'danger', 'Invalid blood bank review action.');
    return res.redirect('/admin');
  }
  const result = req.params.action === 'verify'
    ? await BloodBank.updateOne(
      { _id: req.params.id, verified: false },
      { $set: { verified: true } },
    )
    : await BloodBank.deleteOne({ _id: req.params.id, verified: false });
  const changed = req.params.action === 'verify' ? result.modifiedCount : result.deletedCount;
  flash(req, changed ? 'success' : 'warning',
    changed
      ? req.params.action === 'verify' ? 'Blood bank listing verified and published.' : 'Unverified blood bank submission rejected.'
      : 'This blood bank submission was not changed.');
  res.redirect('/admin');
}));

app.post('/admin/request/:id/:status', asyncRoute(async (req, res) => {
  if (req.params.status === 'Fulfilled') {
    try {
      const changed = await withMongoTransaction(async (session) => {
        const request = await BloodRequest.findOne({
          _id: req.params.id,
          status: 'Approved',
        }).session(session).lean();
        if (!request) return false;

        const stockUpdate = await BloodStock.updateOne(
          { bloodGroup: request.bloodGroup, units: { $gte: request.units } },
          { $inc: { units: -request.units } },
          { session, runValidators: true },
        );
        if (stockUpdate.modifiedCount !== 1) throw new InsufficientStockError();

        const requestUpdate = await BloodRequest.updateOne(
          { _id: request._id, status: 'Approved' },
          { $set: { status: 'Fulfilled', fulfilledAt: new Date(), fulfilledBy: req.session.user.id } },
          { session },
        );
        if (requestUpdate.modifiedCount !== 1) {
          throw new Error('Request status changed before fulfillment completed.');
        }
        return true;
      });
      flash(req, changed ? 'success' : 'warning',
        changed ? 'Request fulfilled and inventory updated.' : 'Request status was not changed.');
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        flash(req, 'danger', 'There is not enough recorded inventory for this blood group to fulfill the request.');
      } else if (error instanceof MongoReplicaSetRequiredError) {
        flash(req, 'danger', 'Request fulfillment requires MongoDB to run as a replica set. No data was changed.');
      } else {
        throw error;
      }
    }
    return res.redirect('/admin');
  }

  const allowedTransitions = {
    Approved: ['Pending'],
    Rejected: ['Pending', 'Approved'],
  };
  const previous = allowedTransitions[req.params.status];
  if (!previous) {
    flash(req, 'danger', 'Invalid request status.');
    return res.redirect('/admin');
  }
  const result = await BloodRequest.updateOne(
    { _id: req.params.id, status: { $in: previous } },
    { $set: { status: req.params.status } },
  );
  flash(req, result.modifiedCount ? 'success' : 'warning',
    result.modifiedCount ? `Request marked ${req.params.status.toLowerCase()}.` : 'Request status was not changed.');
  res.redirect('/admin');
}));

app.post('/admin/account/:id/deletion-request/review', asyncRoute(async (req, res) => {
  const result = await User.updateOne(
    {
      _id: req.params.id,
      accountStatus: 'deletion_requested',
      deletionReviewedAt: null,
    },
    {
      $set: {
        deletionReviewedAt: new Date(),
        deletionReviewedBy: req.session.user.id,
      },
    },
  );
  flash(req, result.modifiedCount ? 'success' : 'warning',
    result.modifiedCount
      ? 'Account deactivation request marked reviewed. No records were deleted.'
      : 'This account request was not changed.');
  res.redirect('/admin');
}));

app.post('/admin/contact/:id/:status', asyncRoute(async (req, res) => {
  if (!['Reviewed', 'Closed'].includes(req.params.status)) {
    flash(req, 'danger', 'Invalid contact status.');
    return res.redirect('/admin');
  }
  await ContactMessage.updateOne({ _id: req.params.id }, { $set: { status: req.params.status } });
  flash(req, 'success', 'Contact enquiry updated.');
  res.redirect('/admin');
}));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', message: 'We could not find the page you requested.' });
});

app.use((error, req, res, next) => {
  logServerError(error);
  if (req.file) removeDonorPhoto(req.file.filename).catch(logServerError);
  if (res.headersSent) return next(error);
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return res.status(400).render('error', { title: 'Invalid information', message: 'Please check the information you submitted and try again.' });
  }
  if (req.method === 'GET' && req.path === '/donors') {
    return res.status(500).render('error', {
      title: 'Donor search unavailable',
      message: 'We could not load donor results right now. Please try your search again in a moment.',
    });
  }
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: process.env.NODE_ENV === 'production'
      ? 'The request could not be completed. Please try again later.'
      : 'The server could not complete this request. Check the server console for details.',
  });
});

export { app, migrateLegacyAccountStatus, migrateUnverifiableDonorConsent };

if (process.env.NODE_ENV !== 'test') {
  mongoClientPromise
    .then((mongoClient) => {
      sessionMiddleware = session({
        ...sessionOptions,
        store: MongoStore.create({ client: mongoClient, collectionName: 'sessions' }),
      });
      return app.listen(port, () => console.log(`LifeLine running at http://localhost:${port}`));
    })
    .catch(async (error) => {
      console.error('MongoDB connection failed. Check MONGODB_URI and database availability.');
      logServerError(error);
      await mongoose.disconnect().catch(logServerError);
      process.exitCode = 1;
    });
}
