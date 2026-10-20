const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
async function main() {
  const [email, confirmation] = process.argv.slice(2);
  const projectId =
    process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

  if (confirmation !== "--confirm-owner-bootstrap") {
    throw new Error(
      "Usage: node scripts/grant-owner.js owner@example.com --confirm-owner-bootstrap",
    );
  }

  if (!email || !projectId) {
    throw new Error(
      "Provide the first owner's email and set GCLOUD_PROJECT to your Firebase project ID.",
    );
  }

  initializeApp({
    credential: applicationDefault(),
    projectId,
  });

  const auth = getAuth();
  const user = await auth.getUserByEmail(email);
  if (!user.emailVerified) {
    throw new Error("Verify the owner's email before granting owner access.");
  }
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    const existingOwner = page.users.find(
      (candidate) =>
        candidate.customClaims?.role === "owner" &&
        candidate.uid !== user.uid,
    );
    if (existingOwner) {
      throw new Error(
        "An owner is already assigned. Use that owner account to manage access.",
      );
    }
    pageToken = page.pageToken;
  } while (pageToken);

  const claims = { ...(user.customClaims || {}), role: "owner" };
  delete claims.staffRole;
  delete claims.managerPermissions;
  await auth.setCustomUserClaims(user.uid, claims);

  console.log(`Granted the owner role to ${user.email} in ${projectId}.`);
  console.log(
    "No Firestore database was accessed. Sign out and back in to refresh the owner claim.",
  );
}

main().catch((error) => {
  console.error("Could not bootstrap the owner role:", error.message);
  process.exitCode = 1;
});
