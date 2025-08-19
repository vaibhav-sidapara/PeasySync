// ================================
// CONFIG
// ================================
const manifest = chrome.runtime.getManifest();
const CLIENT_ID = manifest.oauth2.client_id;
const SCOPES = manifest.oauth2.scopes;
const REDIRECT_URL = `https://${chrome.runtime.id}.chromiumapp.org`
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// ================================
// AUTHENTICATION
// ================================
async function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    const url =
      `${AUTH_URL}?client_id=${CLIENT_ID}` +
      `&response_type=token` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URL)}` +
      `&scope=${encodeURIComponent(SCOPES.join(" "))}`;

    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      if (!redirectUrl) {
        reject("No redirect URL");
        return;
      }

      const m = redirectUrl.match(/access_token=([^&]+)/);
      if (m && m[1]) {
        resolve(m[1]);
      } else {
        reject("No access token found in redirect");
      }
    });
  });
}

// ================================
// DRIVE HELPERS
// ================================
async function driveRequest(path, method = "GET", body, token, params = "") {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/${path}${params}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );
  return res.json();
}

async function getOrCreateBackupFolder(token) {
  const search = await driveRequest(
    "files",
    "GET",
    null,
    token,
    `?q=name='Backup' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );

  if (search.files && search.files.length > 0) {
    return search.files[0].id;
  }

  const create = await driveRequest(
    "files",
    "POST",
    {
      name: "Backup",
      mimeType: "application/vnd.google-apps.folder",
    },
    token
  );

  return create.id;
}

// ================================
// UPLOAD BOOKMARKS
// ================================
async function uploadBookmarks(bookmarks) {
  const token = await getAuthToken();
  const folderId = await getOrCreateBackupFolder(token);

  const searchRes = await driveRequest(
    "files",
    "GET",
    null,
    token,
    `?q=name='bookmarks-peasy-sync.json' and '${folderId}' in parents and trashed=false`
  );

  let fileId =
    searchRes.files && searchRes.files.length ? searchRes.files[0].id : null;

  const metadata = {
    name: "bookmarks-peasy-sync.json",
    mimeType: "application/json",
    parents: [folderId],
  };

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  form.append(
    "file",
    new Blob([JSON.stringify(bookmarks, null, 2)], {
      type: "application/json",
    })
  );

  const uploadUrl = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

  const uploadRes = await fetch(uploadUrl, {
    method: fileId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  return uploadRes.json();
}

// ================================
// DOWNLOAD BOOKMARKS
// ================================
async function downloadBookmarks() {
  const token = await getAuthToken();
  const folderId = await getOrCreateBackupFolder(token);

  const searchRes = await driveRequest(
    "files",
    "GET",
    null,
    token,
    `?q=name='bookmarks-peasy-sync.json' and '${folderId}' in parents and trashed=false`
  );

  if (!searchRes.files || !searchRes.files.length) {
    throw new Error("No bookmarks-peasy-sync.json found in Drive/backup folder");
  }

  const fileId = searchRes.files[0].id;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return res.json();
}

// ================================
// RESTORE BOOKMARKS
// ================================
async function restoreBookmarks() {
  const bookmarks = await downloadBookmarks(); // your backup JSON

  // Get current root folders
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0].children; // [Bookmarks Bar, Other, Mobile]

  async function clearChildren(folder) {
    if (!folder.children) return;
    for (const child of folder.children) {
      try {
        await chrome.bookmarks.removeTree(child.id);
      } catch (e) {
        console.warn("Skip remove error:", e);
      }
    }
  }

  function createNode(node, parentId) {
    if (node.url) {
      chrome.bookmarks.create({
        parentId,
        title: node.title || "",
        url: node.url,
      });
    } else {
      chrome.bookmarks.create({ parentId, title: node.title || "Untitled" }, (folder) => {
        if (node.children) {
          node.children.forEach((child) => createNode(child, folder.id));
        }
      });
    }
  }

  // Clear and restore for each main folder
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const backupRoot = bookmarks[0]?.children?.[i];
    if (!backupRoot) continue;

    await clearChildren(root);

    if (backupRoot.children) {
      backupRoot.children.forEach((child) => createNode(child, root.id));
    }
  }
}

// ================================
// MESSAGE HANDLER
// ================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "backup") {
    chrome.bookmarks.getTree().then(async (tree) => {
      try {
        const res = await uploadBookmarks(tree);
        sendResponse({ success: true, res });
      } catch (e) {
        sendResponse({ success: false, error: e.toString() });
      }
    });
    return true;
  }

  if (msg.action === "restore") {
    restoreBookmarks()
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.toString() }));
    return true;
  }
});
