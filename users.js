requireLogin();

async function init() {
  const me = await loadMe();
  if (!me.isAdmin) {
    location.href = "index.html";
    return;
  }

  const listEl = document.getElementById("users-list");
  listEl.innerHTML = "<p>Loading…</p>";

  const res = await apiFetch("/api/admin/users");
  if (!res.ok) {
    listEl.innerHTML = `<p class="error-msg">Could not load users.</p>`;
    return;
  }
  const data = await res.json();

  listEl.innerHTML = "";
  for (const user of data.users) {
    const row = document.createElement("div");
    row.className = "card user-row";
    const created = new Date(user.created_at).toLocaleDateString();
    const isSelf = user.email === me.email;
    row.innerHTML = `
      <div class="user-row-info">
        <div class="user-row-email">${user.email}${user.is_admin ? ' <span class="admin-badge">Admin</span>' : ""}</div>
        <div class="user-row-meta">${user.people_count} student${user.people_count === 1 ? "" : "s"} &middot; ${user.collections_count} collection${user.collections_count === 1 ? "" : "s"} &middot; joined ${created}</div>
      </div>
      ${isSelf ? "" : '<button class="danger">Delete Account</button>'}
    `;
    if (!isSelf) {
      row.querySelector("button").addEventListener("click", async () => {
        if (!confirm(`Permanently delete ${user.email}'s account? This deletes all of their students and photos and cannot be undone.`)) return;
        const delRes = await apiFetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
        const delData = await delRes.json();
        if (!delRes.ok) {
          alert(delData.error || "Could not delete account");
          return;
        }
        row.remove();
      });
    }
    listEl.appendChild(row);
  }

  if (data.users.length === 0) {
    listEl.innerHTML = "<p>No accounts yet.</p>";
  }
}

init();
