# Ztram Cafe production backend

The Firebase project `ztram-cafe` and its `Ztram Cafe Website` web app have been created. The web app's public configuration is in `firebase-config.js`, and `.firebaserc` selects this project for Firebase CLI commands. Email/Password authentication is enabled. The Firestore database has deliberately **not** been created, per the owner's instruction. App Check is not configured because its reCAPTCHA Enterprise site key is not available; protected callable operations now fail clearly instead of sending requests without App Check. Storage, Cloud Functions, and Hosting have not been deployed. **Do not store real business or personal records until the database exists and security rules have been deployed and tested. Cloud Functions deployment requires Blaze billing and may incur charges.**

## Portal interface preview

The homepage now includes customer, staff, owner, administrator/manager, HR and accounts portal previews. These illustrate customer orders/reservations/rewards/support; role-specific staff queues, tables, billing and attendance; and management reports, menu, orders, reservations, inventory, promotions, delivery, security and insights. The dashboard preview controls use sample or browser-preview information only. They do not change Firestore, send orders/support tickets, accept payments, or update real staff/stock records. Firebase authentication buttons use real Firebase Auth only after the project configuration below is complete. Do not enter real business data into the demo preview.

The homepage now has Firebase email/password sign-in, customer self-registration, email verification, password-reset requests, role-claim checks, and TOTP enrollment/sign-in challenge handling. The real Firebase Web app configuration is present; privileged staff accounts are not self-registrable. The owner is bootstrapped locally and separately from administrators. Only the owner can grant administrator, manager, HR and accounts roles; administrators can assign staff responsibilities only. Owners grant each manager an explicit set of operational permissions. Protected HR lifecycle, attendance, payroll-review, staff-directory, audit-log, and selected operations reads/writes have callable back-end support, but cannot run until the database, App Check and Cloud Functions are configured/deployed. Other storefront and portal modules remain previews.

## Security requirement status

Do not present this system as meeting every security checklist item until the required service has been configured, deployed, and tested. Current implementation/provider status:

| Requirement | Current implementation/status |
| --- | --- |
| HTTPS/SSL | Firebase Console/web SDK connections use HTTPS. Firebase Hosting provides HTTPS after deployment; there is no deployed hosting site or custom domain yet. |
| Password hashing | Passwords are managed and hashed by Firebase Authentication (Firebase controls the algorithm and storage). This is not application-managed bcrypt; never store password hashes yourself. |
| Two-factor authentication | The client supports TOTP enrollment and sign-in challenges. Identity Platform and TOTP enforcement are not configured, so 2FA is not yet active for accounts. |
| OTP expiration/rate limiting | TOTP code validation/expiry and Firebase Auth abuse throttling are provider-managed. No custom SMS OTP flow or application-specific per-user quota is deployed. |
| JWT authentication | Firebase Authentication issues and validates its own ID tokens (JWTs); the backend verifies callable auth context and custom role claims. Do not issue a second custom JWT. |
| Role-based access | Role claims, server-side authorization, Firestore rules and Storage rules are defined in source. They are not active in a production deployment until deployed and emulator-tested. |
| SQL injection | This implementation uses Firestore, not SQL. Firestore SDK parameterization and server-side input validation are used; no SQL statements or SQL database are configured. |
| XSS | Dynamic portal data is HTML-escaped and Hosting has a Content-Security-Policy. Review any future HTML rendering and test the deployed policy before launch. |
| CSRF | Backend writes use authenticated Firebase callable requests and bearer ID tokens, not cookie-based app sessions. No separate CSRF-token flow is used; reassess if cookie sessions or other state-changing web endpoints are introduced. |
| Cloudflare DDoS protection | Not configured. Requires a Cloudflare account, domain/DNS configuration and proxy/WAF setup; Firebase's own protections do not mean Cloudflare is enabled. |
| Secure payment gateway | Not integrated. Current ordering/payment UI is preview-only; no payment provider, card data handling, or live payment processing is enabled. |
| Audit logging | Trusted role, HR, payroll and selected business mutations write audit records in Functions source. No deployed database/backend exists yet; logging coverage must be extended and tested for each live mutation. |
| Database encryption | Firestore encrypts stored data by default after the database is created. No database or customer/employee records currently exist. Customer-managed encryption keys are not configured. |
| Daily automated backups | Not configured. Requires a created database plus a scheduled backup/export policy, retention choice, billing review, and restore testing. |
| Security alerts/login notifications | Not configured. Firebase/GCP monitoring policies and any email/SMS notification channel must be set up and tested in the owner's project. |

Firebase App Check is enforced on callable Functions. The client refuses protected callable requests unless App Check initialized successfully. To activate them, configure reCAPTCHA Enterprise for the deployed web domain, put its **site key** in `firebase-config.js`, deploy, then verify App Check metrics before enforcement and test the callable functions. The site key is public; never put a reCAPTCHA secret key in client code.

## Configure authentication before launch

1. The Firebase Web app configuration has already been added to `firebase-config.js`. Firebase Web API keys and App Check site keys are client-visible identifiers, not service-account credentials. Never put an Admin SDK key, private key, or service-account JSON in this file. Restrict the API key to the required Firebase APIs and the actual site domains in Google Cloud Console.
2. Set the Firebase Authentication authorized domains to only the production site and required local development domain. Do not enable unknown domains for convenience. The authorization domain must match the eventual hosting domain.
3. Enable Email/Password sign-in and configure Firebase password policy to require at least 12 characters with uppercase, lowercase, number, and symbol. Enable email verification and email-enumeration protection. Configure the password reset email action URL for the real site.
4. Enable Identity Platform and configure TOTP multi-factor authentication. Require MFA for staff, managers, HR, accounts, admins, and the owner; ensure those accounts enroll an authenticator factor from their signed-in portal's Account security page before enforcement. TOTP enrollment requires the user to re-enter their password. The page can verify TOTP sign-in challenges. Do not rely on a client-side role selector to grant access.
5. Register the web app with Firebase App Check using reCAPTCHA Enterprise and put its site key in `firebase-config.js`. Configure Firebase Authentication's reCAPTCHA Enterprise bot protection for supported sign-up/sign-in flows as well. Verify App Check metrics for the production and development app before enforcing it for Authentication; callable Functions already enforce App Check and require Authentication. Client callable wrappers fail early until App Check is initialized.
6. Customer accounts can self-register. Create or register a verified identity for the owner first. Bootstrap the owner from an authorized local Google Cloud CLI session using the offline script below. After that, only the owner can assign `admin`, `manager`, `hr`, or `accountant`; the owner can also assign staff responsibilities. Admins can assign `staff` responsibilities only to customer/staff accounts and cannot modify privileged accounts. `receptionist` is a separate limited staff responsibility. Managers cannot assign roles or promote accounts.
7. Test registration, verification, password reset, TOTP challenges, disabled accounts, role mismatch, rate limits and each Firestore rule in emulators before connecting real customer data.

No website can guarantee that it will never be hacked or that a user will never be phished. Use unique passwords, MFA, verified domains, monitoring, least-privilege roles, timely dependency updates, backups, and incident-response procedures.

## Security and permissions

- Firebase Authentication owns sign-in identities. The app must never collect or store plaintext passwords or OTPs.
- Firestore rules, Storage rules, Cloud Functions, and the first-owner bootstrap require verified email before granting protected access.
- Customer/staff/manager/HR/accountant/admin role claims are set by trusted Cloud Functions; the separate `owner` claim is created only by the one-time local owner-bootstrap script. No public API can assign `owner`. Clients cannot grant themselves roles, change reward balances, write orders, alter menu prices, or write audit records.
- Customers can read their own profiles, orders, reservations, loyalty entries, and support tickets. Staff order queue records omit prices and payment totals. Cashiers can read billing orders. Delivery accounts can read only deliveries assigned to their own user ID.
- Managers have no operational permissions by default. The owner may assign them any combination of orders/delivery, reservations/tables, menu, inventory, limited staff directory, and attendance. Server callables and Firestore rules enforce each selected scope. Manager scopes never include role assignment, payroll, HR records, customer profiles, coupons, support tickets, or system settings. Admins can assign staff responsibilities but cannot assign or demote privileged roles; owner access is separate and immutable in the portal.
- HR can read/write hiring candidates, interviews, employee lifecycle records, onboarding/offboarding checklists, and payroll drafts; HR can read and make audited attendance corrections. HR cannot approve or mark payroll paid.
- Accounts (the `accountant` role) can read payroll records and advance an HR-submitted record from pending review to approved and from approved to paid. Accountants cannot edit submitted amounts, access HR/personnel records, or initiate a bank transfer. Admins and the owner can review payroll and apply the backend's allowed status changes.
- Staff-directory records are written only by trusted role-assignment functions. HR/admin and the owner can read them; managers require the separately assigned directory scope and receive only display name, role and active status. Customer profiles are private from staff, managers, HR, and accounts; the admin dashboard's customer view projects only name, email, phone, rewards, and tier.
- Server callables require Firebase App Check as well as Authentication. The front end must initialize App Check with the site's reCAPTCHA provider before it can call these functions.
- All persisted prices and delivery fees use whole Pakistani Rupees (`PKR`). Only Cash on Delivery and pay-at-cafe are accepted by the order function. No live online-payment gateway is configured.
- Function deployment uses `asia-southeast1` (Singapore). Select this region when creating the Firestore database and Storage bucket to keep services close to Sialkot.

## HR and payroll workflow

- Create/verify each person's Firebase Auth identity first. The owner assigns privileged roles and manager scopes from the owner portal; admins can assign staff responsibilities. Role assignment does not create an account or send an invitation email.
- HR can create hiring candidates and interview schedules, add an employee record linked to a verified staff/management UID, maintain onboarding/offboarding tasks, review and correct attendance, and submit payroll amounts as a draft. Attendance corrections retain the previous times in the admin-only audit log.
- Payroll records use whole PKR amounts entered by HR. Net pay is recorded as gross pay minus entered deductions plus entered benefits. The application does **not** calculate Pakistan income tax, statutory deductions, benefits entitlement, or legal payroll compliance; have the owner/accountant verify applicable rules.
- Accounts can approve a pending draft and later mark it paid. This is an auditable status record only; it does not process a payment or prove that a transfer occurred. Managers cannot access payroll or HR/personnel collections.
- HR/payroll and role changes are audit logged. Firestore direct writes are denied; use the authenticated App Check-protected callable functions. Test the rules and callable authorization using emulator accounts for every role before storing personnel or salary information.

## Set up the Firebase project

1. An owner creates a Firebase project for Ztram Cafe and adds a Web app. Use the same project for Authentication, Firestore, Storage, App Check, and Cloud Functions.
2. Check the current Firebase billing requirements before deploying Cloud Functions; Functions deployment generally requires the Blaze pay-as-you-go plan. Set billing alerts and review Firebase/GCP pricing. An alert is not a hard spending cap.
3. In Firebase Console → Authentication → Sign-in method, enable Email/Password and Google sign-in as desired. Enable phone sign-in only after configuring reCAPTCHA and checking current SMS pricing, quotas, and delivery to Pakistani mobile numbers.
4. If two-factor sign-in is required, upgrade/configure Identity Platform, enable the chosen multi-factor provider, and set the intended enforcement policy. An OTP at sign-up or phone sign-in alone is not the same as enforced second-factor authentication.
5. Create the Firestore database and Storage bucket in `asia-southeast1`. Do not put real customer records in the project until rules have been deployed and tested.
6. Configure Firebase App Check for the production site's actual domain with reCAPTCHA Enterprise. Do not add the App Check debug token to production or commit it.
7. Install a supported Node.js 22 LTS release, then install the Firebase CLI:

   ```powershell
   npm install --global firebase-tools
   firebase login
   ```

8. From this project folder, link the Firebase project by its real project ID. Replace the example ID; do not include angle brackets:

   ```powershell
   firebase use --add
   ```

   Select the project in the CLI prompts. The local `.firebaserc` is ignored by Git; use `--project YOUR_FIREBASE_PROJECT_ID` on deploy commands when needed.
9. Install the backend dependencies and run the checks:

   ```powershell
   npm --prefix functions install
   npm --prefix functions run check
   ```

10. Deploy the security rules before connecting real users:

   ```powershell
   firebase deploy --only firestore:rules,firestore:indexes,storage --project YOUR_FIREBASE_PROJECT_ID
   ```

11. Deploy the trusted API and static site:

   ```powershell
   firebase deploy --only functions,hosting --project YOUR_FIREBASE_PROJECT_ID
   ```

## Create the first owner account

1. Register the owner email through the normal customer sign-up so Firebase Auth can verify it, or create and verify the identity through an authorized Firebase Auth workflow. The first sign-up initially has customer access; it does not grant owner privileges. Do not paste a password, OTP, private key, or service-account file into chat or commit one to the repository.
2. Install the Google Cloud CLI and authenticate locally with an account authorized for this Firebase project:

   ```powershell
   gcloud auth application-default login
   $env:GCLOUD_PROJECT = "YOUR_FIREBASE_PROJECT_ID"
   node functions/scripts/grant-owner.js "owner@example.com" --confirm-owner-bootstrap
   ```

3. This local script requires the target Firebase Auth account to exist and have a verified email. It refuses to replace a different existing owner. It sets only the owner custom role claim; it does not create or access Firestore and is not exposed as a public function. The owner must sign out and back in to refresh the claim. Protect the Google Cloud account and never save its private credentials in the repository.
4. Only the owner portal can grant administrator, manager, HR and accounts roles. Admins can assign staff responsibilities, including receptionist, but cannot change privileged users. Managers cannot assign roles. Never add a default privileged account or password to website source code.

## Important before accepting real orders

- The current on-page cart, sample PKR prices, coupon, reservation, and checkout are **preview-only** and use the visitor's browser. They are not connected to these functions. Never treat their local preview records as cafe orders or bookings.
- Before loading the Firestore menu, the owner must confirm the actual items, PKR prices, availability, delivery area, fees, free-delivery threshold, opening hours, allergy/dietary labels, and cancellation/refund policy.
- Configure real profile, staff, menu, coupon, order, reservation, attendance, and inventory screens to call the server functions. Do not make the client writable for financial, role, inventory, status, or loyalty data.
- Test Firestore and Storage rules using Firebase Emulator Suite and accounts for each role before launch. In particular, verify that kitchen/waiter accounts cannot read billing totals or customer profiles, delivery staff see only assigned deliveries, managers cannot view system settings, and customers cannot read another customer's data.
- Configure privacy notice, retention/deletion procedures, backups, log access, support contact, and applicable Pakistan legal/consumer requirements before inviting real customers.
- SMS reminders, push notifications, AI assistance, live GPS routing, and online payments need separately configured providers and owner approval. They are not included by merely deploying these files.

## Backend endpoints prepared

- `ensureCustomerProfile`: create a customer profile from the signed-in Firebase identity; clients cannot choose their own role.
- `updateCustomerProfile`: update validated customer contact details and up to five Sialkot delivery addresses.
- `submitOrder`: load authoritative prices from active Firestore menu items, calculate delivery/coupon totals on the server, and create a customer order plus a price-free kitchen queue record.
- `updateOrderStatus`: enforce role-specific status transitions; customers may only cancel their own newly received order.
- `submitReservation` / `updateReservation`: create bookings and allow the owner to cancel; waiter, manager, or admin accounts manage approvals and seating.
- `setUserRole`: owner-only grants/removals for admin, manager, HR and accounts roles; admin can assign staff responsibilities only. Manager scopes are stored in verified custom claims and validated against the allowlist. Staff assignments also maintain the restricted staff directory. No callable can assign `owner`.
- `assignDelivery`: admins/owners or managers with the owner-assigned orders scope can assign prepared delivery orders to verified delivery staff.
- `upsertMenuItem` / `updateInventoryItem`: manager/admin menu and stock changes are validated by the server.
- `upsertCoupon`: admin-only coupon creation and updates; order checkout checks coupon status, expiry, minimum subtotal, discount, and redemption limit on the server.
- `clockAttendance`: staff attendance is recorded by the server using the Pakistan local date.
- `submitSupportTicket`: customer-owned support requests; only the customer, admin or owner can read the ticket.

All callable endpoints enforce Firebase App Check. They will reject calls until App Check is configured for the production web app.
