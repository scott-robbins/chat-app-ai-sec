const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const modelSelector = document.getElementById("model-selector");
const fileStatus = document.getElementById("file-status");

// File Upload Elements
const fileInput = document.getElementById("file-input");

// Sidebar Elements
const sidebar = document.getElementById("memory-sidebar");
const closeSidebarBtn = document.getElementById("close-sidebar-btn");
const clearVectorBtn = document.getElementById("clear-vector-btn");
const kvDisplay = document.getElementById("kv-profile-display");
const fileListDisplay = document.getElementById("file-list-display");

// Modal Elements
const helpModal = document.getElementById("helpModal");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// Initial Theme Logic
if (localStorage.getItem("chatTheme") === "fancy") {
    document.body.classList.add("theme-fancy");
}

// --- UI TOGGLES ---

function toggleMenu() {
    document.getElementById('app-menu').classList.toggle('show');
}

function toggleHelp() {
    const isVisible = helpModal.style.display === "flex";
    helpModal.style.display = isVisible ? "none" : "flex";
}

function toggleSidebar() {
    sidebar.classList.toggle("open");
    if (sidebar.classList.contains("open")) updateSidebarContent();
}

function toggleTheme() {
    document.body.classList.toggle("theme-fancy");
    const currentTheme = document.body.classList.contains("theme-fancy") ? "fancy" : "plain";
    localStorage.setItem("chatTheme", currentTheme);
}

// Close dropdowns/modals on outside click
window.addEventListener("click", (event) => {
    if (event.target === helpModal) toggleHelp();
    if (!document.querySelector('.brand-container').contains(event.target)) {
        document.getElementById('app-menu').classList.remove('show');
    }
});

// --- CORE LOGIC ---

async function init() {
    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        chatMessages.innerHTML = ''; 
        
        if (res.ok) {
            const data = await res.json();
            if (data.messages && data.messages.length > 0) {
                chatHistory = data.messages;
                chatHistory.forEach(msg => { 
                    if (msg.role !== "system") addMessageToChat(msg.role, msg.content); 
                });
            } else {
                addMessageToChat('assistant', "Hi there! I'm Jolene. How can I help you today?");
            }
        }
    } catch (e) {
        console.error("History failed to load:", e);
    }
}
init();

function renderContent(element, content) {
    element.innerHTML = marked.parse(content);
    element.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
    });
}

async function updateSidebarContent() {
    try {
        const profileRes = await fetch("/api/profile", { headers: { 'x-session-id': sessionId } });
        const profileData = await profileRes.json();
        kvDisplay.innerHTML = `<p><strong>Profile:</strong> ${profileData.profile}</p>
            <p style="margin-top: 8px; font-size: 0.8rem; opacity: 0.8;">
                <i class="ph ph-chat-centered-text"></i> Total Messages: ${profileData.messageCount}
            </p>`;

        const filesRes = await fetch("/api/files", { headers: { 'x-session-id': sessionId } });
        const filesData = await filesRes.json();
        fileListDisplay.innerHTML = (filesData.files?.length > 0) 
            ? filesData.files.map(f => `<li><i class="ph ph-file-text"></i> ${f}</li>`).join("")
            : "<li>No files memorized yet.</li>";
    } catch (e) { console.error("Sidebar update failed:", e); }
}

// --- FILE HANDLING ---

function handleFileSelect() {
    const file = fileInput.files[0];
    if (file) {
        fileStatus.innerText = `Selected: ${file.name} (Click to Memorize)`;
        fileStatus.style.display = "block";
        fileStatus.onclick = memorizeFile; // Click the text to trigger upload
        fileStatus.style.cursor = "pointer";
    }
}

async function memorizeFile() {
    const file = fileInput.files[0];
    if (!file) return;

    fileStatus.innerText = `Memorizing ${file.name}...`;
    const formData = new FormData();
    formData.append("file", file);

    try {
        const res = await fetch("/api/memorize", {
            method: "POST",
            headers: { "x-session-id": sessionId },
            body: formData
        });
        if (res.ok) {
            addMessageToChat("assistant", `I've successfully memorized **${file.name}**!`);
            fileInput.value = "";
            fileStatus.style.display = "none";
            updateSidebarContent();
        }
    } catch (e) { fileStatus.innerText = "Error memorizing file."; }
}

// --- MESSAGING ---

async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isProcessing) return;

    isProcessing = true;
    addMessageToChat("user", message);
    userInput.value = "";
    chatHistory.push({ role: "user", content: message });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ messages: chatHistory }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const msgEl = createMessageElement("assistant");
        chatMessages.appendChild(msgEl);
        const contentEl = msgEl.querySelector(".message-content");
        
        let text = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const dataString = line.slice(6).trim();
                    if (dataString === "[DONE]") break;
                    try {
                        const json = JSON.parse(dataString);
                        text += json.response || "";
                        renderContent(contentEl, text);
                    } catch (e) {}
                }
            }
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        chatHistory.push({ role: "assistant", content: text });
    } catch (err) {
        addMessageToChat("assistant", "Error: " + err.message);
    } finally {
        isProcessing = false;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function createMessageElement(role) {
    const div = document.createElement("div");
    div.className = `message ${role}-message`;
    div.innerHTML = `<div class="message-content"></div>`;
    return div;
}

function addMessageToChat(role, content) {
    const el = createMessageElement(role);
    renderContent(el.querySelector(".message-content"), content);
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- GLOBAL UTILITIES ---

function clearScreen() {
    chatMessages.innerHTML = '';
    addMessageToChat('assistant', "Screen cleared.");
}

function newChat() {
    localStorage.removeItem("chatSessionId");
    location.reload(); 
}

// --- LISTENERS ---
sendButton?.addEventListener("click", sendMessage);
userInput?.addEventListener("keydown", (e) => { 
    if (e.key === "Enter" && !e.shiftKey) { 
        e.preventDefault(); 
        sendMessage(); 
    } 
});
closeSidebarBtn?.addEventListener("click", () => sidebar.classList.remove("open"));
