// State
let currentModalBook = null;
let selectedServer = "audiobook";
let currentUser = null;
let editingUsername = null;
let cachedAvailability = null;

const DISCOVERY_CATEGORIES = [
    { key: "new_releases", title: "New Releases" },
    { key: "trending", title: "Trending" },
    { key: "best_sellers", title: "Best Sellers" },
    { key: "fiction", title: "Popular Fiction" },
    { key: "science_fiction", title: "Science Fiction" },
    { key: "mystery", title: "Mystery & Thriller" },
    { key: "fantasy", title: "Fantasy" },
    { key: "romance", title: "Romance" },
    { key: "nonfiction", title: "Non-Fiction" },
    { key: "history", title: "History" },
    { key: "classics", title: "Classics" },
];

// ─── Auth ───

async function loadCurrentUser() {
    try {
        const resp = await fetch("/api/auth/me");
        if (resp.status === 401) {
            window.location.href = "/login";
            return;
        }
        currentUser = await resp.json();

        // Show admin-only elements if user is admin
        if (currentUser.role === "admin") {
            document.body.classList.add("is-admin");
        }

        // Set sidebar user info
        document.getElementById("sidebar-username").textContent = currentUser.username;
        document.getElementById("sidebar-role").textContent = currentUser.role === "admin" ? "Approver" : "";
    } catch (err) {
        window.location.href = "/login";
    }
}

async function doLogout() {
    try {
        await fetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
        // ignore
    }
    window.location.href = "/login";
}

// ─── 401 Interceptor ───

const originalFetch = window.fetch;
window.fetch = async function (...args) {
    const resp = await originalFetch.apply(this, args);
    if (resp.status === 401) {
        window.location.href = "/login";
    }
    return resp;
};

// ─── Sidebar ───

function openSidebar() {
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("sidebar-overlay").classList.add("active");
}

function closeSidebar() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebar-overlay").classList.remove("active");
}

// ─── Navigation ───

document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelectorAll(".sidebar-link").forEach((l) => l.classList.remove("active"));
        link.classList.add("active");
        document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
        const pageId = "page-" + link.dataset.page;
        document.getElementById(pageId).classList.add("active");
        if (link.dataset.page === "requests") loadRequests();
        if (link.dataset.page === "settings") loadConfig();
        if (link.dataset.page === "users") { loadUsers(); loadJellyfin(); loadAudiobookshelf(); loadLDAP(); loadOIDC(); }
        closeSidebar();
    });
});

// ─── Search ───

const searchInput = document.getElementById("search-input");

searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

let searchTimeout;
searchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(doSearch, 500);
});

async function doSearch() {
    const query = searchInput.value.trim();
    const container = document.getElementById("discovery-content");
    const grid = document.getElementById("search-results");

    // Make sure we're on the search page
    if (!document.getElementById("page-search").classList.contains("active")) {
        document.querySelector('[data-page="search"]').click();
    }

    if (!query) {
        loadDiscovery();
        return;
    }

    // Switch to search mode
    container.style.display = "none";
    grid.style.display = "";

    grid.innerHTML = '<div class="empty-state"><div class="spinner"></div> Searching...</div>';

    try {
        const resp = await fetch("/api/search?q=" + encodeURIComponent(query));
        const data = await resp.json();
        if (data.error) {
            grid.innerHTML = `<div class="empty-state">Error: ${data.error}</div>`;
            return;
        }
        if (!data.length) {
            grid.innerHTML = '<div class="empty-state">No results found</div>';
            return;
        }
        grid.innerHTML = data.map(renderBookCard).join("");
        grid.querySelectorAll(".book-card").forEach((card) => {
            card.addEventListener("click", () => openDownloadModal(JSON.parse(card.dataset.book)));
        });
        fetchAvailability().then(applyAvailabilityBadges);
    } catch (err) {
        grid.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
    }
}

function renderBookCard(book) {
    const title = book.title || "Unknown Title";
    const author = book.author?.authorName || (Array.isArray(book.authors) ? book.authors.join(", ") : "Unknown Author");
    const year = book.releaseDate ? book.releaseDate.substring(0, 4) : book.publishedDate ? book.publishedDate.substring(0, 4) : "";
    let cover = "";
    if (book.author?.images?.length) cover = book.author.images[0].url;
    if (!cover && book.images?.length) cover = book.images[0].url;
    if (!cover && book.cover) cover = book.cover;
    const bookJson = JSON.stringify(book).replace(/"/g, "&quot;");

    return `
        <div class="book-card" data-book="${bookJson}">
            ${cover
                ? `<img class="book-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'), {className: 'book-cover book-cover-blank', textContent: this.closest('.book-card').querySelector('.book-title').textContent}))">`
                : `<div class="book-cover book-cover-blank">${esc(title)}</div>`}
            <div class="book-overlay">
                <div class="book-overlay-title">${title}</div>
                <div class="book-overlay-author">${author}${year ? " (" + year + ")" : ""}</div>
            </div>
            <div class="book-info">
                <div class="book-title" title="${title}">${title}</div>
                <div class="book-author">${author}</div>
                ${year ? `<div class="book-year">${year}</div>` : ""}
            </div>
        </div>`;
}

async function fetchAvailability() {
    if (cachedAvailability) return cachedAvailability;
    try {
        const resp = await fetch("/api/availability");
        cachedAvailability = await resp.json();
    } catch {
        cachedAvailability = { ebook: { isbns: [], titles: [] }, audiobook: { isbns: [], titles: [] } };
    }
    return cachedAvailability;
}

function applyAvailabilityBadges(availability) {
    document.querySelectorAll(".book-card").forEach((card) => {
        if (card.querySelector(".book-badges")) return;
        let book;
        try { book = JSON.parse(card.dataset.book); } catch { return; }
        const isbn = book.isbn_13 || book.isbn_10 || book.isbn13 || book.isbn10 || "";
        const title = (book.title || "").toLowerCase();

        const hasEbook = (isbn && availability.ebook.isbns.includes(isbn)) ||
            (title && availability.ebook.titles.includes(title));
        const hasAudiobook = (isbn && availability.audiobook.isbns.includes(isbn)) ||
            (title && availability.audiobook.titles.includes(title)) ||
            Boolean((availability.listen || {})[normTitle(book.title)]);
        const ebookRequested = availability.ebook_requests &&
            ((isbn && availability.ebook_requests.isbns.includes(isbn)) ||
            (title && availability.ebook_requests.titles.includes(title)));
        const audiobookRequested = availability.audiobook_requests &&
            ((isbn && availability.audiobook_requests.isbns.includes(isbn)) ||
            (title && availability.audiobook_requests.titles.includes(title)));

        // "Requested" takes priority over "available" for the same server type
        const showEbook = ebookRequested ? "requested" : (hasEbook ? "available" : null);
        const showAudiobook = audiobookRequested ? "requested" : (hasAudiobook ? "available" : null);

        if (!showEbook && !showAudiobook) return;

        let html = '<div class="book-badges">';
        if (showEbook === "available") html += '<span class="book-badge ebook">eBook ✓</span>';
        else if (showEbook === "requested") html += '<span class="book-badge ebook-requested">eBook Requested</span>';
        if (showAudiobook === "available") html += '<span class="book-badge audiobook">On GOJ</span>';
        else if (showAudiobook === "requested") html += '<span class="book-badge audiobook-requested">Audiobook Requested</span>';
        html += '</div>';
        card.querySelector(".book-info").insertAdjacentHTML("beforeend", html);
    });
}

function renderDiscoveryRow(category) {
    const cards = category.books.map(renderBookCard).join("");
    return `
        <div class="discovery-row">
            <div class="discovery-row-header">
                <div class="discovery-row-title">${category.title}</div>
            </div>
            <div class="discovery-row-scroll">${cards}</div>
        </div>`;
}

async function loadDiscovery() {
    const container = document.getElementById("discovery-content");
    const searchResults = document.getElementById("search-results");

    container.style.display = "";
    searchResults.style.display = "none";

    container.innerHTML = '<div class="discovery-loading"><div class="spinner"></div> Loading discovery...</div>';

    const promises = DISCOVERY_CATEGORIES.map(async (cat) => {
        try {
            const resp = await fetch("/api/discover?category=" + encodeURIComponent(cat.key) + "&limit=20");
            const data = await resp.json();
            if (data.error || !data.length) return null;
            return { ...cat, books: data };
        } catch {
            return null;
        }
    });

    const results = await Promise.all(promises);
    const valid = results.filter(Boolean);

    if (!valid.length) {
        container.innerHTML = '<div class="empty-state">Unable to load discovery content</div>';
        return;
    }

    container.innerHTML = valid.map(renderDiscoveryRow).join("");

    container.querySelectorAll(".book-card").forEach((card) => {
        card.addEventListener("click", () => {
            openDownloadModal(JSON.parse(card.dataset.book));
        });
    });
    fetchAvailability().then(applyAvailabilityBadges);
}

// ─── Request Modal ───

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Mirrors book_matching.norm_title on the server.
function normTitle(title) {
    let t = String(title || "").toLowerCase().split(/[:(\[]/)[0];
    t = t.replace(/[^a-z0-9]+/g, " ").trim();
    return t.replace(/^(the|a|an)\s+/, "").trim();
}

function bookAuthor(book) {
    return book.author?.authorName || (Array.isArray(book.authors) ? book.authors.join(", ") : "");
}

function isAdmin() {
    return currentUser && currentUser.role === "admin";
}

async function openDownloadModal(book) {
    currentModalBook = book;
    document.getElementById("modal-book-title").textContent = book.title || "Unknown title";
    document.getElementById("modal-book-author").textContent = bookAuthor(book).split(", ")[0];
    const cover = document.getElementById("modal-cover");
    cover.src = book.cover || "";
    cover.style.visibility = book.cover ? "visible" : "hidden";

    document.querySelectorAll(".server-btn").forEach((btn) => {
        btn.onclick = () => selectServer(btn.dataset.server);
    });
    document.getElementById("download-modal").classList.add("active");
    await selectServer("audiobook");
}

function closeModal() {
    document.getElementById("download-modal").classList.remove("active");
    currentModalBook = null;
}

async function selectServer(server) {
    selectedServer = server;
    document.querySelectorAll(".server-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.server === server);
    });
    const btn = document.getElementById("confirm-download-btn");
    const listenBox = document.getElementById("modal-listen");
    const hint = document.getElementById("modal-hint");
    const label = server === "audiobook" ? "audiobook" : "eBook";

    btn.style.display = "";
    btn.textContent = `Request ${label}`;
    listenBox.style.display = "none";
    hint.textContent = isAdmin()
        ? "You're an approver, so this starts searching right away."
        : `Ryan or Justin approves requests, then we find the ${label}. We'll email you when it's ready.`;

    if (server !== "audiobook" || !currentModalBook) return;
    const availability = await fetchAvailability();
    const link = (availability.listen || {})[normTitle(currentModalBook.title)];
    if (link) {
        listenBox.innerHTML = `This one is already on GOJ. <a href="${esc(link)}" target="_blank" rel="noopener">Listen now</a>`;
        listenBox.style.display = "";
        btn.style.display = "none";
        hint.textContent = "";
    }
}

document.getElementById("confirm-download-btn").addEventListener("click", async () => {
    if (!currentModalBook) return;
    const btn = document.getElementById("confirm-download-btn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending";

    try {
        const resp = await fetch("/api/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ server_type: selectedServer, book: currentModalBook }),
        });
        const data = await resp.json();
        if (data.error === "already_available") {
            cachedAvailability = null;
            await selectServer(selectedServer);
            return;
        }
        if (data.error) {
            document.getElementById("modal-hint").textContent = "That didn't go through: " + data.error;
            return;
        }
        cachedAvailability = null;
        closeModal();
        document.querySelector('[data-page="requests"]').click();
    } catch (err) {
        document.getElementById("modal-hint").textContent = "That didn't go through. Check your connection and try again.";
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
});

// ─── Requests ───

// Status as language (Jack-Vault Design/Switchboard.md): never raw states.
const REQUEST_STATES = {
    pending: { cls: "waiting", label: "Waiting for approval", sub: "Ryan or Justin will approve it soon." },
    processing: { cls: "searching", label: "Searching for a copy", sub: "This can take a few hours." },
    downloading: { cls: "downloading", label: "Downloading", sub: "Almost there." },
    completed: { cls: "ready", label: "Ready", sub: "" },
    error: { cls: "problem", label: "Couldn't get this one", sub: "" },
    declined: { cls: "declined", label: "Not approved", sub: "Ask Ryan if you'd like to talk it over." },
};

async function loadRequests() {
    const list = document.getElementById("requests-list");
    document.getElementById("requests-heading").textContent = isAdmin() ? "All requests" : "My requests";
    try {
        const resp = await fetch("/api/requests");
        const data = await resp.json();
        if (!data.length) {
            list.innerHTML = '<div class="empty-state">Nothing requested yet. Search for a book and tap it to ask for the audiobook.</div>';
            return;
        }
        list.innerHTML = data.map(renderRequest).join("");
        list.querySelectorAll("[data-action]").forEach((btn) => {
            btn.addEventListener("click", () => requestAction(btn.dataset.action, parseInt(btn.dataset.id), btn));
        });
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Couldn\'t load your requests. Refresh the page to try again.</div>';
    }
}

async function requestAction(action, id, btn) {
    if (action === "remove" && !confirm("Remove this request?")) return;
    btn.disabled = true;
    if (action === "remove") {
        await fetch("/api/requests/" + id, { method: "DELETE" });
    } else if (action === "retry") {
        await fetch(`/api/requests/${id}/retry`, { method: "POST" });
    }
    loadRequests();
}

function renderRequest(req) {
    const state = REQUEST_STATES[req.status] || REQUEST_STATES.processing;
    const format = req.server_type === "ebook" ? "eBook" : "Audiobook";
    let sub = state.sub;
    if (req.status === "completed") sub = req.listen_url ? "" : `Find it in the ${format === "eBook" ? "eBook" : "Audiobooks"} app.`;
    if (req.status === "error") sub = req.error || "Something went wrong.";
    if (req.status === "downloading" && req.progress > 0 && req.progress < 100) sub = `${req.progress}% downloaded`;

    const actions = [];
    if (req.listen_url) actions.push(`<a class="btn btn-small btn-listen" href="${esc(req.listen_url)}" target="_blank" rel="noopener">Listen now</a>`);
    if (req.status === "error") actions.push(`<button class="btn btn-small btn-primary" data-action="retry" data-id="${req.id}">Try again</button>`);
    if (["pending", "error", "declined"].includes(req.status) || isAdmin()) {
        actions.push(`<button class="btn btn-small btn-quiet" data-action="remove" data-id="${req.id}">Remove</button>`);
    }
    const by = isAdmin() && req.requested_by ? `<div class="request-by">Asked by ${esc(req.requested_by)}</div>` : "";
    const cover = req.cover_url
        ? `<img class="request-cover" src="${esc(req.cover_url)}" alt="" onerror="this.style.visibility='hidden'">`
        : '<div class="request-cover"></div>';

    return `
        <div class="request-item">
            ${cover}
            <div class="request-details">
                <div class="request-title">${esc(req.title)}</div>
                <div class="request-meta">${esc(req.author || "")} · ${format}</div>
                ${by}
            </div>
            <div class="request-status">
                <span class="request-state ${state.cls}">${state.label}</span>
                ${sub ? `<div class="request-sub">${esc(sub)}</div>` : ""}
                <div class="request-actions">${actions.join("")}</div>
            </div>
        </div>`;
}

document.getElementById("refresh-btn").addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn");
    btn.disabled = true;
    btn.textContent = "Checking";
    try {
        await fetch("/api/requests/refresh", { method: "POST" });
        await loadRequests();
    } finally {
        btn.disabled = false;
        btn.textContent = "Check again";
    }
});

// ─── Settings ───

async function loadConfig() {
    try {
        const resp = await fetch("/api/config");
        const data = await resp.json();
        document.getElementById("ebook-url").value = data.ebook.url || "";
        document.getElementById("ebook-api").value = data.ebook.api_key || "";
        document.getElementById("audiobook-url").value = data.audiobook.url || "";
        document.getElementById("audiobook-api").value = data.audiobook.api_key || "";
        document.getElementById("ebook-server-software").value = data.ebook.server_software || "readarr";
        document.getElementById("audiobook-server-software").value = data.audiobook.server_software || "readarr";
    } catch (err) {
        console.error("Failed to load config", err);
    }
}

window.saveConfig = async function (type) {
    const url = document.getElementById(type + "-url").value;
    const api_key = document.getElementById(type + "-api").value;
    const server_software = document.getElementById(type + "-server-software").value;
    const statusEl = document.getElementById(type + "-status");

    try {
        const resp = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ server_type: type, url, api_key, server_software }),
        });
        const data = await resp.json();
        statusEl.className = "status-msg success";
        statusEl.textContent = "Configuration saved!";
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }

    setTimeout(() => { statusEl.textContent = ""; }, 3000);
};

window.testConnection = async function (type) {
    const url = document.getElementById(type + "-url").value;
    const api_key = document.getElementById(type + "-api").value;
    const server_software = document.getElementById(type + "-server-software").value;
    const statusEl = document.getElementById(type + "-status");

    statusEl.className = "status-msg";
    statusEl.textContent = "Testing...";

    try {
        const resp = await fetch("/api/config/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, api_key, server_software }),
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.className = "status-msg success";
            statusEl.textContent = "Connected! Version: " + (data.status.version || "unknown");
        } else {
            statusEl.className = "status-msg error";
            statusEl.textContent = "Failed: " + data.error;
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
};

// ─── User Management ───

async function loadUsers() {
    const list = document.getElementById("users-list");
    try {
        const resp = await fetch("/api/users");
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.length) {
            list.innerHTML = '<div class="empty-state">No users found</div>';
            return;
        }
        list.innerHTML = data.map(renderUser).join("");
        list.querySelectorAll(".edit-user-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                openEditUserModal(btn.dataset.username, btn.dataset.role);
            });
        });
        list.querySelectorAll(".delete-user-btn").forEach((btn) => {
            btn.addEventListener("click", async () => {
                if (!confirm("Delete user '" + btn.dataset.username + "'?")) return;
                try {
                    const resp = await fetch("/api/users/" + encodeURIComponent(btn.dataset.username), {
                        method: "DELETE",
                    });
                    const data = await resp.json();
                    if (data.error) {
                        alert(data.error);
                    } else {
                        loadUsers();
                    }
                } catch (err) {
                    alert("Error: " + err.message);
                }
            });
        });
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Error loading users</div>';
    }
}

function renderUser(user) {
    const initial = user.username.charAt(0);
    const createdDate = user.created_at ? new Date(user.created_at).toLocaleDateString() : "Unknown";
    const isSelf = currentUser && user.username === currentUser.username;
    const deleteDisabled = isSelf ? "disabled" : "";
    const deleteStyle = isSelf ? 'style="opacity:0.4;cursor:not-allowed;"' : "";

    return `
        <div class="user-item">
            <div class="user-avatar">${initial}</div>
            <div class="user-details">
                <div class="user-name">${user.username}${isSelf ? " (you)" : ""}</div>
                <div class="user-meta">Created ${createdDate}</div>
            </div>
            <span class="user-role-badge ${user.role}">${user.role}</span>
            <div class="user-actions">
                <button class="btn btn-small btn-secondary edit-user-btn"
                        data-username="${user.username}" data-role="${user.role}">Edit</button>
                <button class="btn btn-small btn-danger delete-user-btn"
                        data-username="${user.username}" ${deleteDisabled} ${deleteStyle}>Delete</button>
            </div>
        </div>`;
}

function openAddUserModal() {
    editingUsername = null;
    document.getElementById("user-modal-title").textContent = "Add User";
    document.getElementById("user-modal-username").value = "";
    document.getElementById("user-modal-username").disabled = false;
    document.getElementById("user-modal-password").value = "";
    document.getElementById("user-modal-role").value = "user";
    document.getElementById("user-modal-error").style.display = "none";
    document.getElementById("user-modal").classList.add("active");
}

function openEditUserModal(username, role) {
    editingUsername = username;
    document.getElementById("user-modal-title").textContent = "Edit User";
    document.getElementById("user-modal-username").value = username;
    document.getElementById("user-modal-username").disabled = true;
    document.getElementById("user-modal-password").value = "";
    document.getElementById("user-modal-password").placeholder = "Leave blank to keep current password";
    document.getElementById("user-modal-role").value = role;
    document.getElementById("user-modal-error").style.display = "none";
    document.getElementById("user-modal").classList.add("active");
}

function closeUserModal() {
    document.getElementById("user-modal").classList.remove("active");
    document.getElementById("user-modal-password").placeholder = "Enter password";
    editingUsername = null;
}

window.saveUserModal = async function () {
    const username = document.getElementById("user-modal-username").value.trim();
    const password = document.getElementById("user-modal-password").value;
    const role = document.getElementById("user-modal-role").value;
    const errorEl = document.getElementById("user-modal-error");
    const btn = document.getElementById("user-modal-save-btn");

    errorEl.style.display = "none";

    if (!username) {
        errorEl.textContent = "Username is required";
        errorEl.style.display = "block";
        return;
    }

    if (!editingUsername && !password) {
        errorEl.textContent = "Password is required for new users";
        errorEl.style.display = "block";
        return;
    }

    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
        let resp;
        if (editingUsername) {
            // Edit existing user
            const body = { role };
            if (password) body.password = password;
            resp = await fetch("/api/users/" + encodeURIComponent(editingUsername), {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } else {
            // Create new user
            resp = await fetch("/api/users", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password, role }),
            });
        }

        const data = await resp.json();
        if (data.error) {
            errorEl.textContent = data.error;
            errorEl.style.display = "block";
        } else {
            closeUserModal();
            loadUsers();
        }
    } catch (err) {
        errorEl.textContent = "Error: " + err.message;
        errorEl.style.display = "block";
    } finally {
        btn.disabled = false;
        btn.textContent = "Save";
    }
};

// Close modals on background click
document.getElementById("download-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
});
document.getElementById("user-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeUserModal();
});

// ─── Jellyfin Configuration ───

async function loadJellyfin() {
    try {
        const resp = await fetch("/api/jellyfin");
        const data = await resp.json();
        document.getElementById("jellyfin-enabled").checked = data.enabled || false;
        document.getElementById("jellyfin-server-url").value = data.server_url || "";
        document.getElementById("jellyfin-default-role").value = data.default_role || "user";
    } catch (err) {
        console.error("Failed to load Jellyfin config", err);
    }
}

window.saveJellyfin = async function () {
    const statusEl = document.getElementById("jellyfin-status");
    try {
        const resp = await fetch("/api/jellyfin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                enabled: document.getElementById("jellyfin-enabled").checked,
                server_url: document.getElementById("jellyfin-server-url").value,
                default_role: document.getElementById("jellyfin-default-role").value,
            }),
        });
        const data = await resp.json();
        if (data.error) {
            statusEl.className = "status-msg error";
            statusEl.textContent = data.error;
        } else {
            statusEl.className = "status-msg success";
            statusEl.textContent = "Jellyfin configuration saved!";
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
    setTimeout(() => { statusEl.textContent = ""; }, 3000);
};

window.testJellyfin = async function () {
    const statusEl = document.getElementById("jellyfin-status");
    statusEl.className = "status-msg";
    statusEl.textContent = "Testing...";
    try {
        const resp = await fetch("/api/jellyfin/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                server_url: document.getElementById("jellyfin-server-url").value,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.className = "status-msg success";
            statusEl.textContent = data.message;
        } else {
            statusEl.className = "status-msg error";
            statusEl.textContent = "Failed: " + data.error;
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
};

// ─── Audiobookshelf Configuration ───

async function loadAudiobookshelf() {
    try {
        const resp = await fetch("/api/audiobookshelf");
        const data = await resp.json();
        document.getElementById("audiobookshelf-enabled").checked = data.enabled || false;
        document.getElementById("audiobookshelf-server-url").value = data.server_url || "";
        document.getElementById("audiobookshelf-api-key").value = data.api_key || "";
    } catch (err) {
        console.error("Failed to load Audiobookshelf config", err);
    }
}

window.saveAudiobookshelf = async function () {
    const statusEl = document.getElementById("audiobookshelf-status");
    try {
        const resp = await fetch("/api/audiobookshelf", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                enabled: document.getElementById("audiobookshelf-enabled").checked,
                server_url: document.getElementById("audiobookshelf-server-url").value,
                api_key: document.getElementById("audiobookshelf-api-key").value,
            }),
        });
        const data = await resp.json();
        if (data.error) {
            statusEl.className = "status-msg error";
            statusEl.textContent = data.error;
        } else {
            statusEl.className = "status-msg success";
            statusEl.textContent = "Audiobookshelf configuration saved!";
            cachedAvailability = null;
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
    setTimeout(() => { statusEl.textContent = ""; }, 3000);
};

window.testAudiobookshelf = async function () {
    const statusEl = document.getElementById("audiobookshelf-status");
    statusEl.className = "status-msg";
    statusEl.textContent = "Testing...";
    try {
        const resp = await fetch("/api/audiobookshelf/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                server_url: document.getElementById("audiobookshelf-server-url").value,
                api_key: document.getElementById("audiobookshelf-api-key").value,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.className = "status-msg success";
            statusEl.textContent = data.message;
        } else {
            statusEl.className = "status-msg error";
            statusEl.textContent = "Failed: " + data.error;
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
};

// ─── LDAP Configuration ───

async function loadLDAP() {
    try {
        const resp = await fetch("/api/ldap");
        const data = await resp.json();
        document.getElementById("ldap-enabled").checked = data.enabled || false;
        document.getElementById("ldap-server-url").value = data.server_url || "";
        document.getElementById("ldap-bind-dn").value = data.bind_dn || "";
        document.getElementById("ldap-bind-password").value = data.bind_password || "";
        document.getElementById("ldap-base-dn").value = data.base_dn || "";
        document.getElementById("ldap-search-filter").value = data.user_search_filter || "(sAMAccountName={username})";
        document.getElementById("ldap-default-role").value = data.default_role || "user";
    } catch (err) {
        console.error("Failed to load LDAP config", err);
    }
}

window.saveLDAP = async function () {
    const statusEl = document.getElementById("ldap-status");
    try {
        const resp = await fetch("/api/ldap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                enabled: document.getElementById("ldap-enabled").checked,
                server_url: document.getElementById("ldap-server-url").value,
                bind_dn: document.getElementById("ldap-bind-dn").value,
                bind_password: document.getElementById("ldap-bind-password").value,
                base_dn: document.getElementById("ldap-base-dn").value,
                user_search_filter: document.getElementById("ldap-search-filter").value,
                default_role: document.getElementById("ldap-default-role").value,
            }),
        });
        const data = await resp.json();
        if (data.error) {
            statusEl.className = "status-msg error";
            statusEl.textContent = data.error;
        } else {
            statusEl.className = "status-msg success";
            statusEl.textContent = "LDAP configuration saved!";
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
    setTimeout(() => { statusEl.textContent = ""; }, 3000);
};

window.testLDAP = async function () {
    const statusEl = document.getElementById("ldap-status");
    statusEl.className = "status-msg";
    statusEl.textContent = "Testing...";
    try {
        const resp = await fetch("/api/ldap/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                server_url: document.getElementById("ldap-server-url").value,
                bind_dn: document.getElementById("ldap-bind-dn").value,
                bind_password: document.getElementById("ldap-bind-password").value,
                base_dn: document.getElementById("ldap-base-dn").value,
                user_search_filter: document.getElementById("ldap-search-filter").value,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.className = "status-msg success";
            statusEl.textContent = data.message;
        } else {
            statusEl.className = "status-msg error";
            statusEl.textContent = "Failed: " + data.error;
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
};

// ─── OIDC Configuration ───

async function loadOIDC() {
    try {
        const resp = await fetch("/api/oidc");
        const data = await resp.json();
        const unavailableEl = document.getElementById("oidc-unavailable");
        if (data.available === false) {
            if (unavailableEl) unavailableEl.style.display = "block";
        } else if (unavailableEl) {
            unavailableEl.style.display = "none";
        }
        document.getElementById("oidc-enabled").checked = data.enabled || false;
        document.getElementById("oidc-display-name").value = data.display_name || "OIDC";
        document.getElementById("oidc-issuer-url").value = data.issuer_url || "";
        document.getElementById("oidc-client-id").value = data.client_id || "";
        document.getElementById("oidc-client-secret").value = data.client_secret || "";
        document.getElementById("oidc-scope").value = data.scope || "openid profile email";
        document.getElementById("oidc-username-claim").value = data.username_claim || "preferred_username";
        document.getElementById("oidc-default-role").value = data.default_role || "user";
        document.getElementById("oidc-auto-create").checked = data.auto_create_users || false;
        document.getElementById("oidc-auto-redirect").checked = data.auto_redirect || false;
    } catch (err) {
        console.error("Failed to load OIDC config", err);
    }
}

window.saveOIDC = async function () {
    const statusEl = document.getElementById("oidc-status");
    try {
        const resp = await fetch("/api/oidc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                enabled: document.getElementById("oidc-enabled").checked,
                display_name: document.getElementById("oidc-display-name").value,
                issuer_url: document.getElementById("oidc-issuer-url").value,
                client_id: document.getElementById("oidc-client-id").value,
                client_secret: document.getElementById("oidc-client-secret").value,
                scope: document.getElementById("oidc-scope").value,
                username_claim: document.getElementById("oidc-username-claim").value,
                default_role: document.getElementById("oidc-default-role").value,
                auto_create_users: document.getElementById("oidc-auto-create").checked,
                auto_redirect: document.getElementById("oidc-auto-redirect").checked,
            }),
        });
        const data = await resp.json();
        if (data.error) {
            statusEl.className = "status-msg error";
            statusEl.textContent = data.error;
        } else {
            statusEl.className = "status-msg success";
            statusEl.textContent = "OIDC configuration saved!";
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
    setTimeout(() => { statusEl.textContent = ""; }, 3000);
};

window.testOIDC = async function () {
    const statusEl = document.getElementById("oidc-status");
    statusEl.className = "status-msg";
    statusEl.textContent = "Testing...";
    try {
        const resp = await fetch("/api/oidc/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                issuer_url: document.getElementById("oidc-issuer-url").value,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.className = "status-msg success";
            statusEl.textContent = data.message;
        } else {
            statusEl.className = "status-msg error";
            statusEl.textContent = "Failed: " + data.error;
        }
    } catch (err) {
        statusEl.className = "status-msg error";
        statusEl.textContent = "Error: " + err.message;
    }
};

// ─── Init ───

// Load current user first, then the rest
loadCurrentUser().then(() => {
    loadConfig();
    loadDiscovery();
});
