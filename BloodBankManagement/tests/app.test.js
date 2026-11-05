import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ejs from 'ejs';
import { BloodRequest, BloodStock, Donor, User } from '../models.js';
import { BLOOD_GROUPS, COMPATIBLE_DONORS, escapeRegex } from '../lib/blood.js';
import { isSupportedDonorPhoto } from '../lib/donor-photo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('all eight blood groups have a compatibility rule', () => {
  assert.equal(BLOOD_GROUPS.length, 8);
  assert.deepEqual(Object.keys(COMPATIBLE_DONORS).sort(), [...BLOOD_GROUPS].sort());
  for (const compatible of Object.values(COMPATIBLE_DONORS)) {
    assert.ok(compatible.length > 0);
    assert.ok(compatible.every((group) => BLOOD_GROUPS.includes(group)));
  }
});

test('city search values are escaped before becoming regular expressions', () => {
  const escaped = escapeRegex('Cuttack (Old)');
  const regex = new RegExp(escaped, 'i');
  assert.equal(regex.test('Cuttack (Old)'), true);
  assert.equal(regex.test('Cuttack Old'), false);
});

test('donor photo validation accepts supported image signatures and rejects mismatches', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = Buffer.from('RIFF0000WEBP', 'ascii');
  assert.equal(isSupportedDonorPhoto(jpeg, 'image/jpeg'), true);
  assert.equal(isSupportedDonorPhoto(png, 'image/png'), true);
  assert.equal(isSupportedDonorPhoto(webp, 'image/webp'), true);
  assert.equal(isSupportedDonorPhoto(jpeg, 'image/png'), false);
  assert.equal(isSupportedDonorPhoto(Buffer.from('<svg></svg>'), 'image/svg+xml'), false);
});

test('donor directory consent defaults to opt-out', () => {
  assert.equal(Donor.schema.path('directoryConsent').defaultValue, false);
  assert.equal(Donor.schema.path('directoryConsentStatus').defaultValue, 'unknown');
  assert.equal(Donor.schema.path('photoConsentStatus').defaultValue, 'unknown');
  assert.equal(Donor.schema.path('available').defaultValue, false);
  assert.ok(Donor.schema.path('directoryConsentStatus').enumValues.includes('unknown'));
});

test('account and inventory schemas enforce safe status and quantity defaults', () => {
  assert.equal(User.schema.path('accountStatus').defaultValue, 'active');
  assert.equal(BloodStock.schema.path('units').options.min, 0);
  assert.equal(BloodRequest.schema.path('units').options.min, 1);
});

test('every page template compiles as EJS', async () => {
  const files = await readdir(path.join(root, 'views'));
  const templates = files.filter((file) => file.endsWith('.ejs'));
  assert.ok(templates.length >= 12);
  for (const file of templates) {
    const source = await readFile(path.join(root, 'views', file), 'utf8');
    assert.doesNotThrow(() => ejs.compile(source, { filename: path.join(root, 'views', file) }), file);
  }
});

test('how-it-works renders blood-group cards with distinct step photos', async () => {
  const html = await ejs.renderFile(path.join(root, 'views', 'how-it-works.ejs'), {
    currentUser: null,
    currentYear: 2026,
    csrfToken: 'test-token',
    flashMessages: [],
    bloodGroups: BLOOD_GROUPS,
    compatibleDonors: COMPATIBLE_DONORS,
  });
  assert.match(html, /<img src="\/images\/blood-donation-banner\.png" alt="A nurse assisting a smiling donor during blood donation"/);
  await readFile(path.join(root, 'static', 'images', 'blood-donation-banner.png'));
  assert.match(html, /class="how-step-photo how-step-donation" src="\/images\/donation-hero\.jpg"/);
  assert.match(html, /\/images\/signup-donation-portrait\.jpg/);
  assert.match(html, /\/images\/donation-hero\.jpg/);
  assert.match(html, /\/images\/about-care\.jpg/);
  const stepImagePaths = [...html.matchAll(/class="how-step-photo [^"]+" src="([^"]+)"/g)]
    .map(([, src]) => src);
  assert.equal(stepImagePaths.length, 3);
  assert.equal(new Set(stepImagePaths).size, 3);
  for (const src of stepImagePaths) {
    await readFile(path.join(root, 'static', src.slice(1)));
  }
  assert.match(html, /data-compatible-groups="A\+\|A-\|O\+\|O-"/);
  assert.match(html, /role="dialog"/);
});

test('about page explains LifeLine and links to donor and request features', async () => {
  const html = await ejs.renderFile(path.join(root, 'views', 'about.ejs'), {
    currentUser: null,
    currentYear: 2026,
    csrfToken: 'test-token',
    flashMessages: [],
  });
  for (const section of [
    'About LifeLine',
    'Our mission &amp; vision',
    'Why choose LifeLine?',
    'How our platform works',
    'Who can use LifeLine?',
    'OUR COMMUNITY IMPACT',
  ]) {
    assert.ok(html.includes(section), `About page should include ${section}`);
  }
  assert.match(html, /href="\/donor\/register"[^>]*>Become a Donor/);
  assert.match(html, /href="\/donors"[^>]*>Find a Donor/);
  for (const [, src] of html.matchAll(/<img src="(\/images\/[^"]+)"/g)) {
    await readFile(path.join(root, 'static', src.slice(1)));
  }
});

test('donor search renders a clear empty state and accessible loading label', async () => {
  const html = await ejs.renderFile(path.join(root, 'views', 'find-donors.ejs'), {
    currentUser: null,
    currentYear: 2026,
    csrfToken: 'test-token',
    flashMessages: [],
    bloodGroups: BLOOD_GROUPS,
    donors: [],
    selectedGroup: 'O+',
    city: 'Cuttack',
    minAge: '',
    maxAge: '',
    gender: '',
    searchActive: true,
  });
  assert.match(html, /method="get" action="\/donors#search-results"/);
  assert.match(html, /name="bloodGroup"/);
  assert.match(html, /name="city"/);
  assert.match(html, /data-loading-text="Searching donors\.\.\."/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<h3>No donors found<\/h3>/);
  assert.match(html, /role="status" aria-live="polite"/);
});

test('donor registration requires directory consent and supports separate photo consent', async () => {
  const html = await ejs.renderFile(path.join(root, 'views', 'donor-register.ejs'), {
    currentUser: null,
    currentYear: 2026,
    csrfToken: 'test-token',
    flashMessages: [],
    bloodGroups: BLOOD_GROUPS,
    donor: null,
    account: null,
  });
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /name="photo" accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /name="directoryConsent"[^>]*required/);
  assert.match(html, /name="directoryConsent"/);
  assert.match(html, /name="photoConsent"/);

  const accountHtml = await ejs.renderFile(path.join(root, 'views', 'donor-register.ejs'), {
    currentUser: { id: 'user-id', name: 'Test User', role: 'user' },
    currentYear: 2026,
    csrfToken: 'test-token',
    flashMessages: [],
    bloodGroups: BLOOD_GROUPS,
    donor: { directoryConsent: false, available: true },
    account: { fullName: 'Test User', phone: '000' },
  });
  assert.match(accountHtml, /name="directoryConsent"/);
  assert.doesNotMatch(accountHtml, /name="directoryConsent"[^>]*required/);
});

test('all route pages render with their expected data shapes', async () => {
  const common = {
    currentUser: null,
    currentYear: 2026,
    csrfToken: 'test-token',
    flashMessages: [],
    bloodGroups: BLOOD_GROUPS,
    compatibleDonors: COMPATIBLE_DONORS,
  };
  const fixtures = {
    home: { totalDonors: 0, totalRequests: 0, totalUnits: 0, inventory: BLOOD_GROUPS.map((bloodGroup) => ({ bloodGroup, units: 0 })) },
    about: {},
    'how-it-works': {},
    privacy: {},
    terms: {},
    'find-donors': { donors: [], selectedGroup: '', city: '', minAge: '', maxAge: '', gender: '', searchActive: false },
    'donor-register': { account: null, donor: null, requireAccount: true },
    login: {},
    signup: {},
    'request-blood': { canSubmit: false },
    'emergency-match': { donors: [], selectedGroup: '', city: '', compatibleGroups: [] },
    'blood-banks': { banks: [], city: '', selectedGroup: '' },
    contact: {},
    dashboard: { account: { fullName: 'Test User', email: 'test@example.com', phone: '000' }, donor: null, requests: [], donations: [], notifications: [] },
    admin: {
      requests: [],
      inventory: [],
      donorCount: 0,
      messages: [],
      pendingBanks: [],
      requestCount: 0,
      pendingRequestCount: 0,
      fulfilledRequestCount: 0,
      bloodGroupStats: BLOOD_GROUPS.map((bloodGroup) => ({ bloodGroup, count: 0 })),
      recentDonors: [],
      recentActivity: [],
      pendingDeletionRequests: [],
    },
    error: { title: 'Test error', message: 'Test details' },
  };

  for (const [view, data] of Object.entries(fixtures)) {
    const html = await ejs.renderFile(path.join(root, 'views', `${view}.ejs`), { ...common, ...data });
    assert.match(html, /<!doctype html>/i, `${view} should render the shared page shell`);
    assert.match(html, /<\/html>/i, `${view} should include the shared footer`);
    if (view === 'dashboard') {
      assert.equal((html.match(/<main\b/g) || []).length, 1, 'dashboard should have one main landmark');
    }
  }
});
