// --- ELEMENT SELECTORS ---
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const modelSelector = document.getElementById("model-selector");
const fileInput = document.getElementById("file-input");

// Modals/Sidebar
const sidebar = document.getElementById("memory-sidebar");
const helpModal = document.getElementById("helpModal");
const kvDisplay = document.getElementById("kv-profile-display");
const fileListDisplay = document.getElementById("file-list-display");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// --- DIRECT UI ACTIONS ---

function toggleTheme() {
    const isFancy = document.body.classList.contains("theme-fancy");
    document.body.classList.remove("theme-fancy", "theme-plain");
    const newTheme = isFancy ? "plain" : "fancy";
    document.body.classList.add(`theme-${newTheme}`);
    localStorage.setItem("chatTheme", newTheme);
    addMessageToChat('assistant', `Theme switched to **${newTheme}** mode.`);
}

function openSidebar() {
    sidebar.classList.add("open");
    updateSidebarContent();
}

function openHelp() {
    helpModal.style.display = "flex";
}

function modelChanged() {
    const name = modelSelector.options[modelSelector.selectedIndex].text;
    addMessageToChat('assistant', `I am now using the **${name}** model.`);
}

function clearScreen() {
    chatMessages.innerHTML = `<div class="message assistant-message"><div class="message-content"><p>Screen cleared! Ready for a fresh start.</p></div></div>`;
    chatHistory = [];
}

function newChat() {
    if(confirm("Start a new session?")) {
        localStorage.removeItem("chatSessionId");
        location.reload();
    }
}

// --- CORE LOGIC ---

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
            body: JSON.stringify({ messages: chatHistory, model: modelSelector.value }),
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

// --- HELPERS (Keep your existing renderContent, createMessageElement, addMessageToChat, updateSidebarContent) ---
function addMessageToChat(role, content) {
    const el = createMessageElement(role);
    renderContent(el.querySelector(".message-content"), content);
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function createMessageElement(role) {
    const div = document.createElement("div");
    div.className = `message ${role}-message`;
    div.innerHTML = `<div class="message-content"></div>`;
    return div;
}

function renderContent(element, content) {
    element.innerHTML = marked.parse(content);
    element.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
}

async function updateSidebarContent() {
    try {
        const profileRes = await fetch("/api/profile", { headers: { 'x-session-id': sessionId } });
        const profileData = await profileRes.json();
        kvDisplay.innerHTML = `<p><strong>Profile:</strong> ${profileData.profile}</p><p style="margin-top: 8px; font-size: 0.8rem; opacity: 0.8;">Total Messages: ${profileData.messageCount}</p>`;
        const filesRes = await fetch("/api/files", { headers: { 'x-session-id': sessionId } });
        const filesData = await filesRes.json();
        fileListDisplay.innerHTML = (filesData.files?.length > 0) ? filesData.files.map(f => `<li><i class="ph ph-file-text"></i> ${f}</li>`).join("") : "<li>No files memorized yet.</li>";
    } catch (e) { console.error("Sidebar error", e); }
}

async function memorizeFile() {
    const file = fileInput.files[0];
    if (!file) return alert("Select a file.");
    const formData = new FormData();
    formData.append("file", file);
    try {
        const res = await fetch("/api/memorize", { method: "POST", headers: { "x-session-id": sessionId }, body: formData });
        if (res.ok) { addMessageToChat("assistant", `Memorized **${file.name}**!`); updateSidebarContent(); }
    } catch (e) { alert("Upload failed."); }
}
