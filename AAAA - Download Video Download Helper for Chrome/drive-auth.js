// Google Drive sign-in for the service worker.
//
// Uses the user's own OAuth client (created free in Google Cloud Console and
// pasted into the dashboard), so no credentials ship with the extension and
// nothing passes through a third-party server. Scope is drive.file — the
// extension can create files and see only the files it created; it cannot
// read anything else in the user's Drive.

const SCP_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SCP_DRIVE_TOKEN_SLACK_MS = 2 * 60 * 1000; // refresh a little early

function scpDriveRedirectUri() {
  return chrome.identity.getRedirectURL();
}

async function scpDriveAccount() {
  const { driveAccount = null } = await chrome.storage.local.get("driveAccount");
  return driveAccount;
}

// Returns a valid access token, signing in silently when possible.
// interactive: may show Google's consent window (only on an explicit click).
// force: ignore the cached token (used after Drive answers 401).
async function scpDriveToken({ interactive = false, force = false } = {}) {
  const settings = await scpLoadSettings();
  if (!settings.driveClientId) {
    throw new Error("Add your Google OAuth client ID in the dashboard first.");
  }

  if (!force) {
    const { driveToken } = await chrome.storage.session.get("driveToken");
    if (driveToken && driveToken.expiresAt - Date.now() > SCP_DRIVE_TOKEN_SLACK_MS) {
      return driveToken.token;
    }
  }

  const params = new URLSearchParams({
    client_id: settings.driveClientId,
    response_type: "token",
    redirect_uri: scpDriveRedirectUri(),
    scope: SCP_DRIVE_SCOPE
  });
  const account = await scpDriveAccount();
  if (account && account.email) params.set("login_hint", account.email);
  // Background refreshes must never open a window.
  if (!interactive) params.set("prompt", "none");

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive
    });
  } catch (e) {
    throw new Error(
      interactive
        ? `Google sign-in was not completed (${e.message}).`
        : "Google Drive needs you to sign in again — open the dashboard and reconnect."
    );
  }

  const fragment = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = fragment.get("access_token");
  if (!token) {
    throw new Error(`Google did not grant access (${fragment.get("error") || "no token returned"}).`);
  }
  const expiresIn = Number(fragment.get("expires_in")) || 3600;
  await chrome.storage.session.set({
    driveToken: { token, expiresAt: Date.now() + expiresIn * 1000 }
  });
  return token;
}

// Explicit connect from the dashboard: sign in, then remember which account.
async function scpDriveConnect() {
  const token = await scpDriveToken({ interactive: true, force: true });
  let account = { email: "", name: "Google Drive", connectedAt: Date.now() };
  try {
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const { user } = await res.json();
      account = {
        email: (user && user.emailAddress) || "",
        name: (user && user.displayName) || "Google Drive",
        connectedAt: Date.now()
      };
    }
  } catch { /* the label is cosmetic; the connection still works */ }
  await chrome.storage.local.set({ driveAccount: account });
  return account;
}

async function scpDriveDisconnect() {
  const { driveToken } = await chrome.storage.session.get("driveToken");
  if (driveToken && driveToken.token) {
    // Best effort: also withdraw the grant on Google's side.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(driveToken.token)}`, {
      method: "POST"
    }).catch(() => {});
  }
  await chrome.storage.session.remove("driveToken");
  await chrome.storage.local.remove("driveAccount");
}

async function scpDriveStatus() {
  const settings = await scpLoadSettings();
  const account = await scpDriveAccount();
  return {
    redirectUri: scpDriveRedirectUri(),
    hasClientId: !!settings.driveClientId,
    connected: !!account,
    account,
    enabled: settings.driveEnabled
  };
}
