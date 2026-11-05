import mongoose from 'mongoose';
import { BLOOD_GROUPS } from './lib/blood.js';

const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 120 },
  phone: { type: String, required: true, trim: true, maxlength: 20 },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  accountStatus: { type: String, enum: ['active', 'deletion_requested'], default: 'active' },
  deletionRequestedAt: { type: Date, default: null },
  deletionReviewedAt: { type: Date, default: null },
  deletionReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
userSchema.index({ accountStatus: 1, deletionRequestedAt: 1 });

const donorSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  fullName: { type: String, required: true, trim: true, maxlength: 100 },
  phone: { type: String, required: true, trim: true, maxlength: 20 },
  bloodGroup: { type: String, enum: BLOOD_GROUPS, required: true },
  age: { type: Number, min: 18, max: 65, required: true },
  gender: { type: String, enum: ['Prefer not to say', 'Female', 'Male', 'Other'], default: 'Prefer not to say' },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  address: { type: String, trim: true, maxlength: 255 },
  lastDonationDate: { type: Date, default: null },
  available: { type: Boolean, default: false },
  directoryConsent: { type: Boolean, default: false },
  directoryConsentStatus: { type: String, enum: ['unknown', 'consented', 'withdrawn'], default: 'unknown' },
  directoryConsentUpdatedAt: { type: Date, default: null },
  directoryConsentPolicyVersion: { type: String, maxlength: 30, default: null },
  photoPath: { type: String, maxlength: 100, default: null },
  photoConsent: { type: Boolean, default: false },
  photoConsentStatus: { type: String, enum: ['unknown', 'consented', 'withdrawn'], default: 'unknown' },
  photoConsentUpdatedAt: { type: Date, default: null },
}, { timestamps: true });
donorSchema.index({ bloodGroup: 1, city: 1, available: 1, directoryConsentStatus: 1 });
donorSchema.index({ phone: 1 }, { unique: true });
donorSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });

const stockSchema = new mongoose.Schema({
  bloodGroup: { type: String, enum: BLOOD_GROUPS, unique: true, required: true },
  units: { type: Number, min: 0, max: 100000, default: 0 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

const requestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  patientName: { type: String, required: true, trim: true, maxlength: 100 },
  bloodGroup: { type: String, enum: BLOOD_GROUPS, required: true },
  units: { type: Number, min: 1, max: 20, required: true },
  hospital: { type: String, required: true, trim: true, maxlength: 150 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  contactPhone: { type: String, required: true, trim: true, maxlength: 20 },
  message: { type: String, trim: true, maxlength: 500, default: '' },
  urgency: { type: String, enum: ['Normal', 'Urgent', 'Emergency'], default: 'Normal' },
  status: { type: String, enum: ['Pending', 'Approved', 'Fulfilled', 'Rejected', 'Cancelled'], default: 'Pending' },
  fulfilledAt: { type: Date, default: null },
  fulfilledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
requestSchema.index({ user: 1, createdAt: -1 });

const donationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  donationDate: { type: Date, required: true },
  center: { type: String, trim: true, maxlength: 150 },
  notes: { type: String, trim: true, maxlength: 300 },
}, { timestamps: true });
donationSchema.index({ user: 1, donationDate: -1 });

const bankSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 150 },
  address: { type: String, required: true, trim: true, maxlength: 255 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  phone: { type: String, trim: true, maxlength: 20 },
  email: { type: String, trim: true, maxlength: 120 },
  openingHours: { type: String, trim: true, maxlength: 200 },
  bloodGroups: { type: [{ type: String, enum: BLOOD_GROUPS }], default: [] },
  verified: { type: Boolean, default: false },
}, { timestamps: true });
bankSchema.index({ city: 1, verified: 1 });

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
  subject: { type: String, required: true, trim: true, maxlength: 150 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  status: { type: String, enum: ['New', 'Reviewed', 'Closed'], default: 'New' },
}, { timestamps: true });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
export const Donor = mongoose.models.Donor || mongoose.model('Donor', donorSchema);
export const BloodStock = mongoose.models.BloodStock || mongoose.model('BloodStock', stockSchema);
export const BloodRequest = mongoose.models.BloodRequest || mongoose.model('BloodRequest', requestSchema);
export const Donation = mongoose.models.Donation || mongoose.model('Donation', donationSchema);
export const BloodBank = mongoose.models.BloodBank || mongoose.model('BloodBank', bankSchema);
export const ContactMessage = mongoose.models.ContactMessage || mongoose.model('ContactMessage', contactSchema);
