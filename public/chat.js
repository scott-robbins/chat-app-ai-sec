const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const modelSelector = document.getElementById("model-selector");

// File Upload Elements
const fileInput = document.getElementById("file-input");
const memorizeBtn = document.getElementById("memorize-file-btn");

// Sidebar Elements
const sidebar = document.getElementById("memory-sidebar");
const toggleSidebarBtn = document.getElementById("toggle-sidebar-btn");
const closeSidebarBtn = document.getElementById("close-sidebar-btn");
const clearVectorBtn = document.getElementById("clear-vector-btn");
const kvDisplay = document.getElementById("kv-profile-display");
const fileListDisplay = document.getElementById("file-list-display");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// Initial Theme Logic
if (localStorage.getItem("chatTheme") === "fancy") {
    document.body.classList.add("theme-fancy");
}

themeToggleBtn?.addEventListener("click", () => {
    document.body.classList.toggle("theme-fancy");
    const currentTheme = document.body.classList.contains("theme-fancy") ? "fancy" : "plain";
    localStorage.setItem("chatTheme", currentTheme);
});

// Initialization - Load history and sync KV preferences
async function init() {
    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        chatMessages.innerHTML = ''; 
        
        if (res.ok) {
            const data = await res.json();
            const activeTheme = data.theme || localStorage.getItem("chatTheme") || "fancy";
            
            if (activeTheme === "fancy") {
                document.body.classList.add("theme-fancy");
            } else {
                document.body.classList.remove("theme-fancy");
            }
            localStorage.setItem("chatTheme", activeTheme);

            if (data.messages && data.messages.length > 0) {
                chatHistory = data.messages;
                chatHistory.forEach(msg => { 
                    if (msg.role !== "system") addMessageToChat(msg.role, msg.content); 
                });
            } else {
                addMessageToChat('assistant', "Hi there! I'm Jolene. I'm here to help you brainstorm, analyze files, or even generate some art. What's on your mind today?");
            }
        }
    } catch (e) {
        console.error("History failed to load:", e);
        addMessageToChat('assistant', "Hi! I'm Jolene. Ready to start a new session.");
    }
}
init();

function renderContent(element, content) {
    element.innerHTML = marked.parse(content);
}

// --- SIDEBAR MANAGEMENT ---

async function updateSidebarContent() {
    try {
        // Fetch Profile and D1 Stats
        const profileRes = await fetch("/api/profile", { headers: { 'x-session-id': sessionId } });
        const profileData = await profileRes.json();
        
        // Display Profile and Message Count
        kvDisplay.innerHTML = `
            <p><strong>Profile:</strong> ${profileData.profile}</p>
            <p style="margin-top: 8px; font-size: 0.8rem; opacity: 0.8;">
                <i class="ph ph-chat-centered-text"></i> Total Messages: ${profileData.messageCount}
            </p>
        `;

        // Fetch Files (Updated to handle object list with keys)
        const filesRes = await fetch("/api/files", { headers: { 'x-session-id': sessionId } });
        const filesData = await filesRes.json();
        
        fileListDisplay.innerHTML = ""; // Clear existing list

        if (filesData.files && filesData.files.length > 0) {
            filesData.files.forEach(file => {
                const li = document.createElement("li");
                
                // Logic to handle object-based file list from updated index.ts
                const fullKey = typeof file === 'string' ? file : file.key;
                
                // Clean up the name for display (strip folder paths)
                const fileName = fullKey.split('/').pop();
                const isUpload = fullKey.includes('uploads/');
                const isGenerated = fullKey.includes('generated/');

                li.innerHTML = `
                    <i class="ph ${isGenerated ? 'ph-image' : 'ph-file-text'}" 
                       style="color: ${isUpload ? 'var(--primary-color)' : 'var(--text-light)'}"></i>
                    <span title="${fullKey}">${fileName}</span>
                `;
                fileListDisplay.appendChild(li);
            });
        } else {
            fileListDisplay.innerHTML = "<li>No files memorized yet.</li>";
        }
    } catch (e) {
        console.error("Sidebar update failed:", e);
        kvDisplay.innerText = "Error loading memory data.";
    }
}

toggleSidebarBtn?.addEventListener("click", () => {
    sidebar.classList.add("open");
    updateSidebarContent();
});

closeSidebarBtn?.addEventListener("click", () => sidebar.classList.remove("open"));

clearVectorBtn?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to wipe Jolene's file memory? This will delete all files in R2.")) return;
    
    clearVectorBtn.innerText = "Wiping...";
    try {
        const res = await fetch("/api/clear-memory", { 
            method: "POST", 
            headers: { 'x-session-id': sessionId } 
        });
        if (res.ok) {
            alert("Memory cleared! Jolene has forgotten your uploaded files.");
            updateSidebarContent();
        }
    } catch (e) {
        alert("Failed to clear memory.");
    } finally {
        clearVectorBtn.innerHTML = `<i class="ph ph-warning"></i> Wipe All Knowledge`;
    }
});

// --- MEMORIZE FILE LOGIC ---
memorizeBtn?.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) return alert("Please choose a file first!");

    memorizeBtn.disabled = true;
    memorizeBtn.innerText = "Memorizing...";
    typingIndicator?.classList.add("visible");

    const formData = new FormData();
    formData.append("file", file);

    try {
        const res = await fetch("/api/memorize", {
            method: "POST",
            headers: { "x-session-id": sessionId },
            body: formData
        });

        if (res.ok) {
            addMessageToChat("assistant", `I've successfully memorized **${file.name}**! You can now ask me questions about its content.`);
            fileInput.value = ""; 
            if (sidebar.classList.contains("open")) updateSidebarContent();
        } else {
            const errorText = await res.text();
            addMessageToChat("assistant", "Sorry, I had trouble memorizing that file: " + errorText);
        }
    } catch (e) {
        addMessageToChat("assistant", "Network error. I couldn't reach the server.");
    } finally {
        memorizeBtn.disabled = false;
        memorizeBtn.innerText = "Memorize File";
        typingIndicator?.classList.remove("visible");
    }
});

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
                model: modelSelector?.value || "@cf/meta/llama-3.2-11b-vision-instruct" 
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
        
        if (sidebar.classList.contains("open")) updateSidebarContent();
        
    } catch (err) {
        addMessageToChat("assistant", "Error: " + err.message);
    } finally {
        isProcessing = false;
        typingIndicator?.classList.remove("visible");
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

// --- Event Listeners ---
sendButton?.addEventListener("click", sendMessage);

userInput?.addEventListener("keydown", (e) => { 
    if (e.key === "Enter" && !e.shiftKey) { 
        e.preventDefault(); 
        sendMessage(); 
    } 
});

newChatBtn?.addEventListener("click", () => {
    localStorage.removeItem("chatSessionId");
    sessionId = crypto.randomUUID();
    localStorage.setItem("chatSessionId", sessionId);
    chatHistory = [];
    isProcessing = false;
    location.reload(); 
});

clearScreenBtn?.addEventListener("click", () => {
    chatMessages.innerHTML = '';
    isProcessing = false;
    addMessageToChat('assistant', "Screen cleared! I'm ready for a fresh start.");
});

modelSelector?.addEventListener("change", () => {
    const selectedModelName = modelSelector.options[modelSelector.selectedIndex].text;
    const notification = document.createElement("div");
    notification.style.textAlign = "center";
    notification.style.fontSize = "0.75rem";
    notification.style.margin = "15px 0";
    notification.style.color = "var(--text-color)";
    notification.style.opacity = "0.6";
    notification.innerHTML = `— Model switched to <strong>${selectedModelName}</strong> —`;
    chatMessages.appendChild(notification);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});
