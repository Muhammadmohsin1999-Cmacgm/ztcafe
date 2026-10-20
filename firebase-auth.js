import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app-check.js";
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  getIdTokenResult,
  getMultiFactorResolver,
  multiFactor,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  TotpMultiFactorGenerator,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-functions.js";

const client = {
  configured: false,
  appCheckReady: false,
  auth: null,
  functions: null,
  pendingTotpResolver: null,
  pendingTotpHint: null,
  currentUser: () => client.auth?.currentUser || null,
  subscribe: (callback) => {
    if (client.auth) return onAuthStateChanged(client.auth, callback);
    callback(null);
    return () => {};
  },
};

const firebaseConfig = window.ZTRAM_FIREBASE_CONFIG;
const hasConfig =
  firebaseConfig &&
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId &&
  !Object.values(firebaseConfig).some(
    (value) => typeof value === "string" && value.startsWith("YOUR_"),
  );

if (hasConfig) {
  try {
    const app = initializeApp(firebaseConfig);
    if (
      firebaseConfig.recaptchaEnterpriseSiteKey &&
      !firebaseConfig.recaptchaEnterpriseSiteKey.startsWith("YOUR_")
    ) {
      try {
        initializeAppCheck(app, {
          provider: new ReCaptchaEnterpriseProvider(
            firebaseConfig.recaptchaEnterpriseSiteKey,
          ),
          isTokenAutoRefreshEnabled: true,
        });
        client.appCheckReady = true;
      } catch (error) {
        console.error("Could not initialize Firebase App Check.", error);
      }
    }
    client.auth = getAuth(app);
    client.functions = getFunctions(app, "asia-southeast1");
    client.configured = true;
  } catch (error) {
    console.error("Could not initialize Firebase Authentication.", error);
  }
}

function callProtectedFunction(name, data = {}) {
  if (!client.configured || !client.functions) {
    throw new Error("Firebase Functions are not configured for this site.");
  }
  if (!client.appCheckReady) {
    throw new Error(
      "Protected business services are unavailable until the Firebase App Check reCAPTCHA Enterprise site key is configured.",
    );
  }
  return httpsCallable(client.functions, name)(data);
}

client.subscribe = (callback) => {
  if (!client.auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(client.auth, callback);
};

client.createCustomerAccount = async (email, password, displayName) => {
  if (!client.auth) throw new Error("Firebase Authentication is not configured.");
  const credential = await createUserWithEmailAndPassword(
    client.auth,
    email,
    password,
  );
  try {
    await updateProfile(credential.user, { displayName });
    await sendEmailVerification(credential.user);
  } finally {
    await signOut(client.auth);
  }
};

client.setRememberMe = (remember) =>
  setPersistence(
    client.auth,
    remember ? browserLocalPersistence : browserSessionPersistence,
  );

client.signIn = async (email, password) => {
  try {
    return await signInWithEmailAndPassword(client.auth, email, password);
  } catch (error) {
    if (error.code !== "auth/multi-factor-auth-required") throw error;
    const resolver = getMultiFactorResolver(client.auth, error);
    const hint = resolver.hints.find(
      (factor) => factor.factorId === TotpMultiFactorGenerator.FACTOR_ID,
    );
    if (!hint) {
      throw new Error(
        "This account requires an unsupported second factor. Contact the cafe administrator.",
      );
    }
    client.pendingTotpResolver = resolver;
    client.pendingTotpHint = hint;
    return { requiresMfa: true };
  }
};

client.verifyTotp = async (code) => {
  if (!client.pendingTotpResolver || !client.pendingTotpHint) {
    throw new Error("The authenticator challenge expired. Sign in again.");
  }
  const assertion = TotpMultiFactorGenerator.assertionForSignIn(
    client.pendingTotpHint.uid,
    code,
  );
  const result = await client.pendingTotpResolver.resolveSignIn(assertion);
  client.pendingTotpResolver = null;
  client.pendingTotpHint = null;
  return result;
};

client.completeSignIn = async (expectedPortal) => {
  const user = client.auth?.currentUser;
  if (!user) throw new Error("Sign in to continue.");
  await reload(user);
  if (!user.emailVerified) {
    try {
      await sendEmailVerification(user);
    } finally {
      await signOut(client.auth);
    }
    const error = new Error(
      "Verify your email using the link sent to your inbox, then sign in again.",
    );
    error.code = "portal/email-not-verified";
    throw error;
  }

  const tokenResult = await getIdTokenResult(user, true);
  const role = tokenResult.claims.role || "customer";
  const staffRole = tokenResult.claims.staffRole || "";
  const authorized =
    (expectedPortal === "customer" && role === "customer") ||
    (expectedPortal === "staff" &&
      role === "staff" &&
      [
        "kitchen",
        "waiter",
        "delivery",
        "cashier",
        "support",
        "receptionist",
      ].includes(
        staffRole,
      )) ||
    (expectedPortal === "owner" && role === "owner") ||
    (expectedPortal === "admin" &&
      ["owner", "admin", "manager"].includes(role)) ||
    (expectedPortal === "hr" &&
      ["owner", "admin", "hr"].includes(role)) ||
    (expectedPortal === "accountant" &&
      ["owner", "admin", "accountant"].includes(role));
  if (!authorized) {
    const error = new Error(
      expectedPortal === "owner" && role !== "owner"
        ? "Sign-in succeeded, but this account does not have the owner role yet. Bootstrap the verified owner's account with functions/scripts/grant-owner.js, then sign out and back in."
        : `Sign-in succeeded, but this account has the "${role}" role and cannot open the ${expectedPortal} portal. Use the portal matching your assigned role, or ask the owner to assign the correct access.`,
    );
    error.code =
      expectedPortal === "owner" && role !== "owner"
        ? "portal/owner-not-provisioned"
        : "portal/role-mismatch";
    await signOut(client.auth);
    throw error;
  }

  let profileReady = true;
  if (role === "customer") {
    try {
      await callProtectedFunction("ensureCustomerProfile");
    } catch (error) {
      console.error("Could not initialize the customer profile.", error);
      profileReady = false;
    }
  }
  const managerPermissions = Array.isArray(tokenResult.claims.managerPermissions)
    ? tokenResult.claims.managerPermissions
    : [];
  return { user, role, staffRole, managerPermissions, profileReady };
};

client.sendPasswordReset = (email) =>
  sendPasswordResetEmail(client.auth, email);

client.assignUserRole = (
  email,
  role,
  staffRole = "",
  managerPermissions = [],
) =>
  callProtectedFunction("setUserRole", {
    email,
    role,
    staffRole,
    managerPermissions,
  });

client.getOrganizationRecords = (collection) =>
  callProtectedFunction("getOrganizationRecords", { collection });

client.upsertHrRecord = (recordType, record) =>
  callProtectedFunction("upsertHrRecord", { recordType, ...record });

client.upsertPayrollRecord = (record) =>
  callProtectedFunction("upsertPayrollRecord", record);

client.adjustAttendance = (record) =>
  callProtectedFunction("adjustAttendance", record);

client.upsertMenuItem = (record) =>
  callProtectedFunction("upsertMenuItem", record);

client.startTotpEnrollment = async (password) => {
  const user = client.auth?.currentUser;
  if (!user || !user.email) throw new Error("Sign in to continue.");
  const credential = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, credential);
  const session = await multiFactor(user).getSession();
  return TotpMultiFactorGenerator.generateSecret(session);
};

client.finishTotpEnrollment = async (secret, code) => {
  const user = client.auth?.currentUser;
  if (!user) throw new Error("Sign in to continue.");
  const assertion = TotpMultiFactorGenerator.assertionForEnrollment(
    secret,
    code,
  );
  await multiFactor(user).enroll(assertion, "Ztram Cafe authenticator");
  await reload(user);
  return user;
};

client.signOut = () => {
  if (!client.auth) throw new Error("Firebase Authentication is not configured.");
  return signOut(client.auth);
};

client.subscribe((user) => {
  document.dispatchEvent(
    new CustomEvent("ztram-auth-state", { detail: { user } }),
  );
});
window.ztramAuth = client;
document.dispatchEvent(new CustomEvent("ztram-auth-ready"));
