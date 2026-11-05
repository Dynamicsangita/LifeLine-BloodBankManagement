import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

const [{ app, migrateLegacyAccountStatus, migrateUnverifiableDonorConsent }, mongooseModule, modelsModule] = await Promise.all([
  import('../server.js'),
  import('mongoose'),
  import('../models.js'),
]);
const mongoose = mongooseModule.default;
const { BloodBank, BloodRequest, BloodStock, ContactMessage, Donor, Donation, User } = modelsModule;

test('duplicate donor phone is rejected without changing the existing record', async () => {
  const databaseName = `lifeline_phone_test_${Date.now()}`;
  const databaseUrl = new URL(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/lifeline');
  databaseUrl.pathname = `/${databaseName}`;
  let server;
  let connected = false;

  try {
    await mongoose.connect(databaseUrl.toString(), { serverSelectionTimeoutMS: 5000 });
    connected = true;
    await Donor.init();
    const indexes = await Donor.collection.indexes();
    assert.ok(indexes.some((index) => index.unique && index.key.phone === 1));

    const legacyDonorResult = await Donor.collection.insertOne({
      fullName: 'Legacy Donor Private',
      phone: '5550102021',
      bloodGroup: 'A+',
      age: 35,
      city: 'LegacyConsentTest',
      available: true,
      directoryConsent: true,
      photoPath: '/donor-photos/abcdefabcdefabcdefabcdefabcdefab.jpg',
      photoConsent: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await migrateUnverifiableDonorConsent();
    const legacyDonor = await Donor.findById(legacyDonorResult.insertedId).lean();
    assert.equal(legacyDonor?.directoryConsentStatus, 'unknown');
    assert.equal(legacyDonor?.directoryConsent, false);
    assert.equal(legacyDonor?.available, false);
    assert.equal(legacyDonor?.photoConsentStatus, 'unknown');
    assert.ok(legacyDonor?.photoPath, 'legacy donor photo record is retained');

    const legacyUserResult = await User.collection.insertOne({
      fullName: 'Legacy Account Preserved',
      email: 'legacy-account@example.invalid',
      phone: '5550102022',
      passwordHash: 'test-only-hash',
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await migrateLegacyAccountStatus();
    const legacyUser = await User.findById(legacyUserResult.insertedId).lean();
    assert.equal(legacyUser?.accountStatus, 'active');
    assert.equal(legacyUser?.email, 'legacy-account@example.invalid');

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const registrationPage = await fetch(`${baseUrl}/donor/register`);
    const registrationHtml = await registrationPage.text();
    const csrfToken = registrationHtml.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    const cookie = registrationPage.headers.get('set-cookie')?.split(';')[0];

    assert.equal(registrationPage.status, 200);
    assert.match(registrationHtml, /action="\/donor\/register"/);
    assert.match(registrationPage.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(registrationPage.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.match(registrationPage.headers.get('set-cookie') || '', /HttpOnly/i);
    assert.match(registrationPage.headers.get('set-cookie') || '', /SameSite=Lax/i);
    assert.ok(csrfToken);
    assert.ok(cookie);
    const legacyPhotoResponse = await fetch(`${baseUrl}/donor-photos/abcdefabcdefabcdefabcdefabcdefab.jpg`);
    assert.equal(legacyPhotoResponse.status, 404);

    const donorSearchPage = await fetch(`${baseUrl}/donors`);
    const donorSearchHtml = await donorSearchPage.text();
    assert.equal(donorSearchPage.status, 200);
    assert.match(donorSearchHtml, /action="\/donors#search-results"/);
    assert.match(donorSearchHtml, /id="search-results"/);

    const submitRegistration = (fullName) => fetch(`${baseUrl}/donor/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrfToken,
        fullName,
        bloodGroup: 'O+',
        phone: '5550102020',
        city: 'PhoneValidationTest',
        age: '30',
        directoryConsent: 'on',
      }),
      redirect: 'manual',
    });

    const invalidPhotoForm = new FormData();
    for (const [field, value] of Object.entries({
      csrfToken,
      fullName: 'Synthetic Invalid Photo',
      bloodGroup: 'O+',
      phone: '5550102023',
      city: 'PhoneValidationTest',
      age: '30',
      directoryConsent: 'on',
      photoConsent: 'on',
    })) {
      invalidPhotoForm.append(field, value);
    }
    invalidPhotoForm.append('photo', new Blob(['<svg>not a PNG</svg>'], { type: 'image/png' }), 'invalid.png');
    const invalidPhotoResponse = await fetch(`${baseUrl}/donor/register`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: invalidPhotoForm,
      redirect: 'manual',
    });
    assert.equal(invalidPhotoResponse.status, 302);
    assert.equal(invalidPhotoResponse.headers.get('location'), '/donor/register');
    assert.equal(await Donor.exists({ phone: '5550102023' }), null);

    const firstRegistration = await submitRegistration('Synthetic Donor One');
    assert.equal(firstRegistration.status, 302);
    assert.match(firstRegistration.headers.get('location') || '', /^\/donors\?/);

    const savedDonor = await Donor.findOne({ phone: '5550102020' }).lean();
    assert.ok(savedDonor);
    assert.equal(savedDonor.directoryConsent, true);
    assert.equal(savedDonor.directoryConsentStatus, 'consented');
    assert.ok(savedDonor.directoryConsentUpdatedAt);
    assert.equal(savedDonor.directoryConsentPolicyVersion, '1.0');
    assert.doesNotMatch(await (await fetch(`${baseUrl}/donors?city=LegacyConsentTest`)).text(), /Legacy Donor Private/);

    await Donor.updateOne({ _id: savedDonor._id }, { $set: { directoryConsent: false } });
    const privateSearchResponse = await fetch(`${baseUrl}/donors?city=PhoneValidationTest`);
    assert.doesNotMatch(await privateSearchResponse.text(), /Synthetic Donor One/);
    await Donor.updateOne({ _id: savedDonor._id }, { $set: { directoryConsent: true } });

    const duplicateRegistration = await submitRegistration('Synthetic Donor Two');
    assert.equal(duplicateRegistration.status, 302);
    assert.equal(duplicateRegistration.headers.get('location'), '/donor/register');

    const duplicateResponse = await fetch(`${baseUrl}/donor/register`, {
      headers: { Cookie: cookie },
    });
    const duplicateHtml = await duplicateResponse.text();
    assert.equal(duplicateResponse.status, 200);
    assert.match(duplicateHtml, /This phone number is already registered as a donor/);

    const donors = await Donor.find({ phone: '5550102020' }).lean();
    assert.equal(donors.length, 1);
    assert.equal(donors[0]._id.toString(), savedDonor._id.toString());
    assert.equal(donors[0].fullName, 'Synthetic Donor One');

    const advancedSearchResponse = await fetch(`${baseUrl}/donors?minAge=30&maxAge=30&gender=Prefer%20not%20to%20say&city=PhoneValidationTest`);
    const advancedSearchHtml = await advancedSearchResponse.text();
    assert.equal(advancedSearchResponse.status, 200);
    assert.match(advancedSearchHtml, /Synthetic Donor One/);
    const invalidSearchResponse = await fetch(`${baseUrl}/donors?minAge=66`, { redirect: 'manual' });
    assert.equal(invalidSearchResponse.status, 302);
    assert.equal(invalidSearchResponse.headers.get('location'), '/donors');
    const missingPage = await fetch(`${baseUrl}/not-a-lifeline-page`);
    assert.equal(missingPage.status, 404);
    assert.match(await missingPage.text(), /Page not found/);

    const searchResponse = await fetch(`${baseUrl}/donors?bloodGroup=O%2B&city=PhoneValidationTest&minAge=30&maxAge=30&gender=Prefer%20not%20to%20say`, {
      headers: { Cookie: cookie },
    });
    const searchHtml = await searchResponse.text();
    assert.equal(searchResponse.status, 200);
    assert.match(searchHtml, /Synthetic Donor One/);
    assert.match(searchHtml, /5550102020/);
    assert.match(searchHtml, /Profile initials for Synthetic Donor One/);
    assert.match(searchHtml, /donor-profile-blood[^>]*>O\+</);
    assert.match(searchHtml, /PhoneValidationTest/);
    assert.match(searchHtml, /no profile photo provided/i);

    const unmatchedSearch = await fetch(`${baseUrl}/donors?bloodGroup=AB%2B&city=PhoneValidationTest`);
    const unmatchedSearchHtml = await unmatchedSearch.text();
    assert.equal(unmatchedSearch.status, 200);
    assert.match(unmatchedSearchHtml, /No donors found/);
    assert.match(unmatchedSearchHtml, /Clear filters/);

    const emergencyResponse = await fetch(`${baseUrl}/emergency-match?bloodGroup=O%2B&city=PhoneValidationTest`, {
      headers: { Cookie: cookie },
    });
    const emergencyHtml = await emergencyResponse.text();
    assert.equal(emergencyResponse.status, 200);
    assert.match(emergencyHtml, /Synthetic Donor One/);

    await BloodBank.create({
      name: 'Synthetic Community Blood Center',
      address: '1 Test Avenue',
      city: 'PhoneValidationTest',
      phone: '5550106060',
      verified: true,
    });
    const bankResponse = await fetch(`${baseUrl}/blood-banks?city=PhoneValidationTest`, {
      headers: { Cookie: cookie },
    });
    const bankHtml = await bankResponse.text();
    assert.equal(bankResponse.status, 200);
    assert.match(bankHtml, /Synthetic Community Blood Center/);

    const contactSubmission = await fetch(`${baseUrl}/contact`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrfToken,
        name: 'Synthetic Test User',
        email: 'test@example.invalid',
        subject: 'Integration test enquiry',
        message: 'Temporary test message.',
      }),
      redirect: 'manual',
    });
    assert.equal(contactSubmission.status, 302);
    assert.equal(await mongoose.connection.db.collection('contactmessages').countDocuments({
      subject: 'Integration test enquiry',
    }), 1);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const rejectedSubmission = await fetch(`${baseUrl}/contact`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrfToken: 'invalid' }),
        redirect: 'manual',
      });
      assert.equal(rejectedSubmission.status, 403);
    }
    const limitedSubmission = await fetch(`${baseUrl}/contact`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrfToken: 'invalid' }),
      redirect: 'manual',
    });
    assert.equal(limitedSubmission.status, 429);

    const publicPaths = [
      '/',
      '/about',
      '/how-it-works',
      '/donors',
      '/donor/register',
      '/login',
      '/signup',
      '/request-blood',
      '/emergency-match',
      '/blood-banks',
      '/contact',
      '/privacy',
      '/terms',
    ];
    for (const route of publicPaths) {
      const response = await fetch(`${baseUrl}${route}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `${route} should load`);
    }
    assert.equal((await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${baseUrl}/admin/reports/requests.csv`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${baseUrl}/admin/inventory`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, bloodGroup: 'O+', units: '1' }),
      redirect: 'manual',
    })).status, 302);

    for (const asset of [
      'about-care.jpg',
      'admin-team.jpg',
      'bank-stock.jpg',
      'blood-request.jpg',
      'community-donation.jpg',
      'contact-support.jpg',
      'donation-hero.jpg',
      'donor-network.jpg',
      'donor-registration.jpg',
      'emergency-care.jpg',
      'login-care.jpg',
      'signup-community.jpg',
    ]) {
      const assetResponse = await fetch(`${baseUrl}/images/${asset}`);
      assert.equal(assetResponse.status, 200, `${asset} should be served`);
      assert.match(assetResponse.headers.get('content-type') || '', /^image\/jpeg/);
    }

    const signupPage = await fetch(`${baseUrl}/signup`, { headers: { Cookie: cookie } });
    const signupHtml = await signupPage.text();
    const signupToken = signupHtml.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    assert.ok(signupToken);
    const signupResponse = await fetch(`${baseUrl}/signup`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: signupToken,
        fullName: 'Synthetic Test Account',
        email: 'account@example.invalid',
        phone: '5550103030',
        password: 'TestPassword!234',
        confirmPassword: 'TestPassword!234',
      }),
      redirect: 'manual',
    });
    assert.equal(signupResponse.status, 302);
    const account = await User.findOne({ email: 'account@example.invalid' });
    assert.ok(account);
    await User.updateOne({ _id: account._id }, { $set: { role: 'admin' } });

    const loginPage = await fetch(`${baseUrl}/login`, { headers: { Cookie: cookie } });
    const loginHtml = await loginPage.text();
    const loginToken = loginHtml.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    assert.ok(loginToken);
    const loginResponse = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: loginToken,
        email: 'account@example.invalid',
        password: 'TestPassword!234',
      }),
      redirect: 'manual',
    });
    assert.equal(loginResponse.status, 302);
    const authenticatedCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
    assert.ok(authenticatedCookie);

    const dashboardResponse = await fetch(`${baseUrl}/dashboard`, {
      headers: { Cookie: authenticatedCookie },
    });
    const dashboardHtml = await dashboardResponse.text();
    const dashboardToken = dashboardHtml.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    assert.equal(dashboardResponse.status, 200);
    assert.ok(dashboardToken);

    const accountDonorResponse = await fetch(`${baseUrl}/donor/register`, {
      method: 'POST',
      headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: dashboardToken,
        fullName: 'Synthetic Test Account',
        bloodGroup: 'A+',
        phone: '5550103030',
        city: 'AccountTestCity',
        age: '28',
        directoryConsent: 'on',
      }),
      redirect: 'manual',
    });
    assert.equal(accountDonorResponse.status, 302);
    const accountDonor = await Donor.findOne({ user: account._id, phone: '5550103030' });
    assert.equal(accountDonor?.directoryConsent, true);
    assert.equal(accountDonor?.directoryConsentStatus, 'consented');
    assert.equal(accountDonor?.available, true);

    const requestResponse = await fetch(`${baseUrl}/request-blood`, {
      method: 'POST',
      headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: dashboardToken,
        bloodGroup: 'A+',
        urgency: 'Emergency',
        patientName: 'Synthetic Patient',
        units: '1',
        hospital: 'Synthetic Community Hospital',
        city: 'AccountTestCity',
        contactPhone: '5550104040',
        message: 'Temporary integration test request.',
      }),
      redirect: 'manual',
    });
    assert.equal(requestResponse.status, 302);
    assert.equal(await BloodRequest.countDocuments({ user: account._id, patientName: 'Synthetic Patient' }), 1);

    const donationResponse = await fetch(`${baseUrl}/donations`, {
      method: 'POST',
      headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: dashboardToken,
        donationDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        center: 'Synthetic Community Center',
        notes: 'Temporary integration test donation.',
      }),
      redirect: 'manual',
    });
    assert.equal(donationResponse.status, 302);
    assert.equal(await Donation.countDocuments({ user: account._id }), 1);

    const authenticatedDashboard = await fetch(`${baseUrl}/dashboard`, {
      headers: { Cookie: authenticatedCookie },
    });
    const authenticatedDashboardHtml = await authenticatedDashboard.text();
    assert.match(authenticatedDashboardHtml, /AccountTestCity/);
    assert.match(authenticatedDashboardHtml, /Synthetic Patient/);
    assert.match(authenticatedDashboardHtml, /Synthetic Community Center/);
    assert.match(authenticatedDashboardHtml, /Your notifications/);

    const adminResponse = await fetch(`${baseUrl}/admin`, {
      headers: { Cookie: authenticatedCookie },
    });
    const adminHtml = await adminResponse.text();
    assert.equal(adminResponse.status, 200);
    assert.match(adminHtml, /Donors by blood group/);
    assert.match(adminHtml, /href="\/donors\?bloodGroup=A%2B"/);
    assert.match(adminHtml, /Recent donor registrations/);
    assert.match(adminHtml, /Consent unverified · private/);
    assert.match(adminHtml, /Recent activity/);
    assert.match(adminHtml, /<strong>1<\/strong><small>Total requests<\/small>/);
    assert.match(adminHtml, /<strong>1<\/strong><small>Pending requests<\/small>/);

    const pendingAccount = await User.create({
      fullName: 'Synthetic Deactivation Review',
      email: 'deactivation-review@example.invalid',
      phone: '5550107072',
      passwordHash: 'test-only-hash',
      accountStatus: 'deletion_requested',
      deletionRequestedAt: new Date(),
    });
    const queueResponse = await fetch(`${baseUrl}/admin`, { headers: { Cookie: authenticatedCookie } });
    assert.match(await queueResponse.text(), /Deactivation requests/);
    const reviewResponse = await fetch(`${baseUrl}/admin/account/${pendingAccount._id}/deletion-request/review`, {
      method: 'POST',
      headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: dashboardToken }),
      redirect: 'manual',
    });
    assert.equal(reviewResponse.status, 302);
    const reviewedAccount = await User.findById(pendingAccount._id).lean();
    assert.ok(reviewedAccount?.deletionReviewedAt);
    assert.equal(String(reviewedAccount?.deletionReviewedBy), String(account._id));
    assert.ok(await User.exists({ _id: pendingAccount._id }), 'review does not delete the account record');

    await BloodRequest.create({
      user: account._id,
      patientName: '=HYPERLINK("https://example.invalid","x")',
      bloodGroup: 'A+',
      units: 1,
      hospital: 'Synthetic Community Hospital',
      city: 'AccountTestCity',
      contactPhone: '5550107070',
    });
    const reportResponse = await fetch(`${baseUrl}/admin/reports/requests.csv`, {
      headers: { Cookie: authenticatedCookie },
    });
    const reportCsv = await reportResponse.text();
    assert.equal(reportResponse.status, 200);
    assert.match(reportResponse.headers.get('content-type') || '', /^text\/csv/);
    assert.match(reportResponse.headers.get('content-disposition') || '', /lifeline-blood-requests\.csv/);
    assert.match(reportCsv, /"Patient","Blood group","Units","Hospital","City","Urgency","Status","Created at"/);
    assert.match(reportCsv, /Synthetic Patient/);
    assert.match(reportCsv, /"'=HYPERLINK\(""https:\/\/example\.invalid"",""x""\)"/);

    const submitAdminForm = (route, fields) => fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: dashboardToken, ...fields }),
      redirect: 'manual',
    });
    const inventoryUpdate = await submitAdminForm('/admin/inventory', {
      bloodGroup: 'O+',
      units: '42',
    });
    assert.equal(inventoryUpdate.status, 302);
    assert.equal((await BloodStock.findOne({ bloodGroup: 'O+' })).units, 42);
    const requestedGroupStock = await submitAdminForm('/admin/inventory', {
      bloodGroup: 'A+',
      units: '3',
    });
    assert.equal(requestedGroupStock.status, 302);
    assert.equal((await BloodStock.findOne({ bloodGroup: 'A+' })).units, 3);

    const submittedRequest = await BloodRequest.findOne({ patientName: 'Synthetic Patient' });
    const requestApproval = await submitAdminForm(`/admin/request/${submittedRequest._id}/Approved`, {});
    assert.equal(requestApproval.status, 302);
    const requestFulfillment = await submitAdminForm(`/admin/request/${submittedRequest._id}/Fulfilled`, {});
    assert.equal(requestFulfillment.status, 302);
    const fulfilledRequest = await BloodRequest.findById(submittedRequest._id).lean();
    assert.equal(fulfilledRequest.status, 'Fulfilled');
    assert.ok(fulfilledRequest.fulfilledAt);
    assert.equal(String(fulfilledRequest.fulfilledBy), String(account._id));
    assert.equal((await BloodStock.findOne({ bloodGroup: 'A+' })).units, 2);

    await BloodRequest.create({
      user: account._id,
      patientName: 'Synthetic Insufficient Stock Patient',
      bloodGroup: 'B+',
      units: 2,
      hospital: 'Synthetic Community Hospital',
      city: 'AccountTestCity',
      contactPhone: '5550107071',
      status: 'Approved',
    });
    const insufficientRequest = await BloodRequest.findOne({ patientName: 'Synthetic Insufficient Stock Patient' });
    const insufficientFulfillment = await submitAdminForm(`/admin/request/${insufficientRequest._id}/Fulfilled`, {});
    assert.equal(insufficientFulfillment.status, 302);
    assert.equal((await BloodRequest.findById(insufficientRequest._id)).status, 'Approved');
    const unavailableStock = await BloodStock.findOne({ bloodGroup: 'B+' }).lean();
    assert.ok(!unavailableStock || unavailableStock.units === 0);

    const invalidInventory = await submitAdminForm('/admin/inventory', {
      bloodGroup: 'A+',
      units: '-1',
    });
    assert.equal(invalidInventory.status, 302);
    assert.equal((await BloodStock.findOne({ bloodGroup: 'A+' })).units, 2);

    const savedMessage = await ContactMessage.findOne({ subject: 'Integration test enquiry' });
    const markMessageReviewed = await submitAdminForm(`/admin/contact/${savedMessage._id}/Reviewed`, {});
    assert.equal(markMessageReviewed.status, 302);
    const closeMessage = await submitAdminForm(`/admin/contact/${savedMessage._id}/Closed`, {});
    assert.equal(closeMessage.status, 302);
    assert.equal((await ContactMessage.findById(savedMessage._id)).status, 'Closed');

    const secondRequest = await submitAdminForm('/request-blood', {
      bloodGroup: 'O-',
      urgency: 'Normal',
      patientName: 'Synthetic Cancellable Request',
      units: '1',
      hospital: 'Synthetic Community Hospital',
      city: 'AccountTestCity',
      contactPhone: '5550105050',
      message: '',
    });
    assert.equal(secondRequest.status, 302);
    const cancellableRequest = await BloodRequest.findOne({ patientName: 'Synthetic Cancellable Request' });
    const cancellation = await submitAdminForm(`/request-blood/${cancellableRequest._id}/cancel`, {});
    assert.equal(cancellation.status, 302);
    assert.equal((await BloodRequest.findById(cancellableRequest._id)).status, 'Cancelled');

    const lastAdminDeactivation = await fetch(`${baseUrl}/account/deletion-request`, {
      method: 'POST',
      headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: dashboardToken, password: 'TestPassword!234' }),
      redirect: 'manual',
    });
    assert.equal(lastAdminDeactivation.status, 302);
    assert.equal((await User.findById(account._id)).accountStatus, 'active');

    await User.updateOne({ _id: account._id }, { $set: { role: 'user' } });
    const revokedAdminResponse = await fetch(`${baseUrl}/admin`, {
      headers: { Cookie: authenticatedCookie },
      redirect: 'manual',
    });
    assert.equal(revokedAdminResponse.status, 302);
    assert.equal(revokedAdminResponse.headers.get('location'), '/dashboard');
    const revokedAdminAction = await submitAdminForm('/admin/inventory', {
      bloodGroup: 'O+',
      units: '1',
    });
    assert.equal(revokedAdminAction.status, 302);
    assert.equal(revokedAdminAction.headers.get('location'), '/dashboard');
    const adminOnlyRoutes = [
      `/admin/reports/requests.csv`,
      '/admin/inventory',
      `/admin/blood-bank/${new mongoose.Types.ObjectId()}/verify`,
      `/admin/request/${submittedRequest._id}/Approved`,
      `/admin/account/${pendingAccount._id}/deletion-request/review`,
      `/admin/contact/${savedMessage._id}/Reviewed`,
    ];
    for (const route of adminOnlyRoutes) {
      const response = route.endsWith('.csv')
        ? await fetch(`${baseUrl}${route}`, { headers: { Cookie: authenticatedCookie }, redirect: 'manual' })
        : await fetch(`${baseUrl}${route}`, {
          method: 'POST',
          headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrfToken: dashboardToken, units: '1', bloodGroup: 'O+' }),
          redirect: 'manual',
        });
      assert.equal(response.status, 302, `${route} should reject a demoted account`);
      assert.equal(response.headers.get('location'), '/dashboard', `${route} should send a demoted account away`);
    }

    const deletionRequest = await fetch(`${baseUrl}/account/deletion-request`, {
      method: 'POST',
      headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: dashboardToken, password: 'TestPassword!234' }),
      redirect: 'manual',
    });
    assert.equal(deletionRequest.status, 302);
    assert.equal((await User.findById(account._id)).accountStatus, 'deletion_requested');
    const retainedDonor = await Donor.findOne({ user: account._id }).lean();
    assert.equal(retainedDonor?.available, false);
    assert.equal(retainedDonor?.directoryConsent, false);
    assert.equal(retainedDonor?.directoryConsentStatus, 'withdrawn');
    assert.ok(await BloodRequest.exists({ user: account._id }));
    assert.ok(await Donation.exists({ user: account._id }));
    const reauthenticationPage = await fetch(`${baseUrl}/login`);
    const reauthenticationHtml = await reauthenticationPage.text();
    const reauthenticationToken = reauthenticationHtml.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    const reauthenticationCookie = reauthenticationPage.headers.get('set-cookie')?.split(';')[0];
    const deactivatedLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { Cookie: reauthenticationCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: reauthenticationToken,
        email: 'account@example.invalid',
        password: 'TestPassword!234',
      }),
      redirect: 'manual',
    });
    assert.equal(deactivatedLogin.status, 302);
    assert.equal(deactivatedLogin.headers.get('location'), '/login');
    const staleSessionResponse = await fetch(`${baseUrl}/dashboard`, {
      headers: { Cookie: authenticatedCookie },
      redirect: 'manual',
    });
    assert.equal(staleSessionResponse.status, 302);
    assert.equal(staleSessionResponse.headers.get('location'), '/login');

    await mongoose.disconnect();
    connected = false;
    await mongoose.connect(databaseUrl.toString(), { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const persistedDonor = await Donor.findById(savedDonor._id).lean();
    assert.equal(persistedDonor?.fullName, 'Synthetic Donor One');
    const reconnectedSearch = await fetch(`${baseUrl}/donors?bloodGroup=O%2B&city=PhoneValidationTest`, {
      headers: { Cookie: authenticatedCookie },
    });
    assert.match(await reconnectedSearch.text(), /Synthetic Donor One/);
  } finally {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (connected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
});
