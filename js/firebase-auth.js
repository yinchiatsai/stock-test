/*
  金雀庫存管理系統 v2.2 Stable｜Firebase Auth + Firestore 同步啟動版
  本版不使用 Firebase Storage，可在 Spark 免費方案下運作。
*/

const firebaseConfig = {
  apiKey: "AIzaSyAVJbQCfJe_4nXZR90ZcXL5NLJM6adeF_g",
  authDomain: "gb-inventory-cc151.firebaseapp.com",
  projectId: "gb-inventory-cc151",
  messagingSenderId: "712712345418",
  appId: "1:712712345418:web:15c29e81420604e9c2d3b3"
};

const USER_ROLES = {
  "goldenbirdhello@gmail.com": "staff",
  "kuangchieh.tai0505@gmail.com": "GJ",
  "unrealmonde@gmail.com": "emily",
  "hey2501@gmail.com": "cing",
  "q82813292@gmail.com": "PX",
  "sun4041098@gmail.com": "boss",
  "adgjl29951@gmail.com":"CU"
};

const ROLE_LABEL = {
  boss: "老闆",
  cing: "青",
  emily: "Emily",
  GJ: "光杰",
  PX: "姵璇",
  CU: "宸瑜",
  staff: "全員 / 美編"
};

window.GB_AUTH = { user: null, role: "staff", ready: false, demoMode: false };
window.GB_FIREBASE = { app: null, auth: null, db: null, ready: false };

function isFirebaseConfigReady() {
  return firebaseConfig.apiKey &&
    firebaseConfig.appId &&
    !firebaseConfig.apiKey.includes("請貼上") &&
    !firebaseConfig.appId.includes("請貼上");
}

function initFirebaseIfReady() {
  if (!isFirebaseConfigReady()) return false;
  if (window.GB_FIREBASE.ready) return true;

  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

  window.GB_FIREBASE.app = firebase.app();
  window.GB_FIREBASE.auth = firebase.auth();
  window.GB_FIREBASE.db = firebase.firestore();
  window.GB_FIREBASE.ready = true;
  return true;
}

function updateAuthSyncStatus(text, type = "") {
  const el = document.getElementById("syncStatusText");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "warn", "bad");
  if (type) el.classList.add(type);
}

function startInventorySyncAfterLogin() {
  updateAuthSyncStatus("同步連線中…", "warn");

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;

    if (
      typeof startRemoteSync === "function" &&
      window.GB_FIREBASE.ready &&
      window.GB_AUTH.ready &&
      window.GB_AUTH.user
    ) {
      clearInterval(timer);
      try {
        startRemoteSync();
      } catch (error) {
        console.error("startRemoteSync failed:", error);
        updateAuthSyncStatus("同步啟動失敗", "bad");
      }
      return;
    }

    if (tries >= 24) {
      clearInterval(timer);
      updateAuthSyncStatus("同步未啟動", "bad");
      console.warn("startRemoteSync not ready", {
        hasStartRemoteSync: typeof startRemoteSync === "function",
        firebaseReady: !!window.GB_FIREBASE.ready,
        authReady: !!window.GB_AUTH.ready,
        user: window.GB_AUTH.user
      });
    }
  }, 250);
}

function applyRoleToUI(role, userText) {
  window.GB_AUTH.role = role || "staff";
  window.GB_AUTH.ready = true;

  const roleSelect = document.getElementById("roleSelect");
  const userInfoText = document.getElementById("userInfoText");
  const authPanel = document.getElementById("authPanel");

  if (roleSelect) {
    roleSelect.value = window.GB_AUTH.role;
    roleSelect.disabled = true;
  }

  if (userInfoText) {
    userInfoText.textContent = userText || ROLE_LABEL[window.GB_AUTH.role] || "已登入";
  }

  document.body.classList.remove("is-logged-out");
  document.body.classList.add("is-logged-in");
  if (authPanel) authPanel.classList.add("hidden");

  window.dispatchEvent(new CustomEvent("gb-role-ready", {
    detail: { role: window.GB_AUTH.role, user: window.GB_AUTH.user }
  }));

  startInventorySyncAfterLogin();

  if (typeof renderAll === "function") {
    try { renderAll(); } catch (error) { console.warn("renderAll after login failed:", error); }
  }
}

function showLoggedOut(message) {
  const authPanel = document.getElementById("authPanel");
  const authMessage = document.getElementById("authMessage");

  window.GB_AUTH.ready = false;
  window.GB_AUTH.user = null;

  document.body.classList.add("is-logged-out");
  document.body.classList.remove("is-logged-in");

  if (authPanel) authPanel.classList.remove("hidden");
  if (authMessage && message) authMessage.textContent = message;
  updateAuthSyncStatus("尚未同步", "warn");
}

async function loginWithGoogle() {
  if (!initFirebaseIfReady()) {
    showLoggedOut("尚未填入完整 Firebase config。");
    return;
  }

  const provider = new firebase.auth.GoogleAuthProvider();
  await window.GB_FIREBASE.auth.signInWithPopup(provider);
}

async function logoutGoogle() {
  if (window.GB_AUTH.demoMode) {
    window.GB_AUTH.demoMode = false;
    window.GB_AUTH.user = null;
    showLoggedOut("已登出測試模式。");
    return;
  }

  if (initFirebaseIfReady()) {
    await window.GB_FIREBASE.auth.signOut();
  } else {
    showLoggedOut("已登出。");
  }
}

function loginDemo() {
  window.GB_AUTH.demoMode = true;
  window.GB_AUTH.user = { email: "demo-boss@example.com", displayName: "測試老闆" };
  applyRoleToUI("boss", "測試模式｜老闆");
}

document.addEventListener("DOMContentLoaded", () => {
  const googleLoginBtn = document.getElementById("googleLoginBtn");
  const demoLoginBtn = document.getElementById("demoLoginBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (googleLoginBtn) googleLoginBtn.addEventListener("click", loginWithGoogle);
  if (demoLoginBtn) demoLoginBtn.addEventListener("click", loginDemo);
  if (logoutBtn) logoutBtn.addEventListener("click", logoutGoogle);

  showLoggedOut(isFirebaseConfigReady()
    ? "請使用公司授權的 Google 帳號登入。"
    : "尚未填入完整 Firebase config。可先用測試模式查看系統。"
  );

  if (!initFirebaseIfReady()) return;

  window.GB_FIREBASE.auth.onAuthStateChanged(user => {
    if (!user) {
      showLoggedOut("請使用公司授權的 Google 帳號登入。");
      return;
    }

    const role = USER_ROLES[user.email] || "staff";
    window.GB_AUTH.user = { email: user.email, displayName: user.displayName };
    applyRoleToUI(role, `${user.displayName || user.email}｜${ROLE_LABEL[role]}`);
  });
});
