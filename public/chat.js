// --- ELEMENT SELECTORS ---
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const modelSelector = document.getElementById("model-selector");

// Buttons (Now in Dropdown or Header)
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const toggleSidebarBtn = document.getElementById("toggle-sidebar-btn");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const helpBtn = document.getElementById("help-btn");

// File Elements
const fileInput = document.getElementById("file-input");
const memorizeBtn = document.getElementById("memorize-file-btn");

// Sidebar & Modals
const sidebar = document.getElementById("memory-sidebar");
const closeSidebarBtn = document.getElementById("close-sidebar-btn");
const clearVectorBtn = document.getElementById("clear-vector-btn");
const kvDisplay = document.getElementById("kv-profile-display");
const fileListDisplay = document.getElementById("file-list-display");
const helpModal = document.getElementById("helpModal");

// --- STATE MANAGEMENT ---
let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// --- INITIALIZATION ---
async function init() {
    // Apply saved theme immediately
    const savedTheme = localStorage.getItem("chatTheme") || "fancy";
    document.body.classList.remove("theme-fancy", "theme-plain");
    document.body.classList.add(`theme-${savedTheme}`);

    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        if (res.ok) {
            const data = await res.json();
            // Only clear if we actually have history to show
            if (data.messages && data.messages.length > 0) {
                chatMessages.innerHTML = ''; 
                chatHistory = data.messages;
                chatHistory.forEach(msg => { 
                    if (msg.role !== "system") addMessageToChat(msg.role, msg.content); 
                });
            }
        }
    } catch (e) {
        console.error("History failed to load:", e);
    }
}
init();

// --- UI HELPERS ---
function renderContent(element, content) {
    element.innerHTML = marked.parse(content);
    element.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
    });
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

function toggleHelp() {
    helpModal.style.display = (helpModal.style.display === "flex") ? "none" : "flex";
}

// --- SIDEBAR & MEMORY ---
async function updateSidebarContent() {
    try {
        const profileRes = await fetch("/api/profile", { headers: { 'x-session-id': sessionId } });
        const profileData = await profileRes.json();
        kvDisplay.innerHTML = `<p><strong>Profile:</strong> ${profileData.profile}</p>
            <p style="margin-top: 8px; font-size: 0.8rem; opacity: 0.8;">Total Messages: ${profileData.messageCount}</p>`;

        const filesRes = await fetch("/api/files", { headers: { 'x-session-id': sessionId } });
        const filesData = await filesRes.json();
        fileListDisplay.innerHTML = (filesData.files?.length > 0) 
            ? filesData.files.map(f => `<li><i class="ph ph-file-text"></i> ${f}</li>`).join("")
            : "<li>No files memorized yet.</li>";
    } catch (e) { console.error("Sidebar update failed:", e); }
}

// --- CORE CHAT LOGIC ---
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isProcessing) return;

    isProcessing = true;
    addMessageToChat("user", message);
    userInput.value = "";
    typingIndicator?.classList.add("visible");
    chatHistory.push({ role: "user", content: message });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ 
                messages: chatHistory,
                model: modelSelector?.value
            }),
        });

        typingIndicator?.classList.remove("visible");
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
        typingIndicator?.classList.remove("visible");
    }
}

// --- FILE MEMORIZATION ---
async function memorizeFile() {
    const file = fileInput.files[0];
    if (!file) return alert("Please select a file first.");

    memorizeBtn.disabled = true;
    memorizeBtn.innerText = "Memorizing...";

    const formData = new FormData();
    formData.append("file", file);

    try {
        const res = await fetch("/api/memorize", {
            method: "POST",
            headers: { "x-session-id": sessionId },
            body: formData
        });
        if (res.ok) {
            addMessageToChat("assistant", `I've memorized **${file.name}**!`);
            fileInput.value = "";
            updateSidebarContent();
        }
    } catch (e) { alert("Error uploading file."); }
    finally {
        memorizeBtn.disabled = false;
        memorizeBtn.innerText = "Memorize";
    }
}

// --- EVENT LISTENERS ---

// Settings Menu Actions
themeToggleBtn?.addEventListener("click", () => {
    const isFancy = document.body.classList.contains("theme-fancy");
    document.body.classList.remove("theme-fancy", "theme-plain");
    const newTheme = isFancy ? "plain" : "fancy";
    document.body.classList.add(`theme-${newTheme}`);
    localStorage.setItem("chatTheme", newTheme);
    addMessageToChat('assistant', `Theme switched to **${newTheme}** mode.`);
});

toggleSidebarBtn?.addEventListener("click", () => {
    sidebar.classList.add("open");
    updateSidebarContent();
});

helpBtn?.addEventListener("click", () => {
    toggleHelp();
});

modelSelector?.addEventListener("change", () => {
    const name = modelSelector.options[modelSelector.selectedIndex].text;
    addMessageToChat('assistant', `I'm now using the **${name}** model.`);
});

// Top Level Actions
clearScreenBtn?.addEventListener("click", () => {
    chatMessages.innerHTML = `<div class="message assistant-message"><div class="message-content"><p>Screen cleared! I'm ready for something new.</p></div></div>`;
    chatHistory = [];
});

newChatBtn?.addEventListener("click", () => {
    localStorage.removeItem("chatSessionId");
    location.reload(); 
});

// Interaction Listeners
sendButton?.addEventListener("click", sendMessage);
userInput?.addEventListener("keydown", (e) => { 
    if (e.key === "Enter" && !e.shiftKey) { 
        e.preventDefault(); 
        sendMessage(); 
    } 
});
closeSidebarBtn?.addEventListener("click", () => sidebar.classList.remove("open"));
memorizeBtn?.addEventListener("click", memorizeFile);

// Outside click for Help Modal
window.onclick = function(event) {
    if (event.target === helpModal) {
        helpModal.style.display = "none";
    }
}
