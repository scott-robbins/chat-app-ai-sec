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

// Voice Elements
const voiceToggleBtn = document.getElementById("voice-toggle-btn");
const voiceIcon = document.getElementById("voice-icon");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;
let voiceEnabled = true;

// --- THE VOICE ENGINE ---
const synth = window.speechSynthesis;

function speak(text) {
    if (!voiceEnabled || !text || !synth) return;
    
    // Stop any current speaking to prevent overlap
    synth.cancel();

    // Clean up Markdown and special characters before speaking
    const cleanText = text
        .replace(/[*#_~]/g, "") // Remove Markdown formatting
        .replace(/\[.*?\]\(.*?\)/g, "") // Remove Markdown links
        .replace(/!\[.*?\]\(.*?\)/g, ""); // Remove image tags

    const utterance = new SpeechSynthesisUtterance(cleanText);
    
    // Attempt to find a high-quality female voice
    const voices = synth.getVoices();
    const preferredVoice = voices.find(v => v.name.includes("Google US English") || v.name.includes("Female") || v.lang === "en-US");
    
    if (preferredVoice) utterance.voice = preferredVoice;
    
    utterance.pitch = 1.1; // Giving Jolene a slightly witty/energetic pitch
    utterance.rate = 1.0;
    
    synth.speak(utterance);
}

// Initial Theme Logic (Local check before server sync)
if (localStorage.getItem("chatTheme") === "fancy") {
    document.body.classList.add("theme-fancy");
}

// --- VOICE TOGGLE LOGIC ---
voiceToggleBtn?.addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    if (voiceIcon) {
        voiceIcon.className = voiceEnabled ? "ph ph-speaker-high" : "ph ph-speaker-slash";
    }
    if (!voiceEnabled) synth.cancel();
});

// --- THEME TOGGLE WITH KV PERSISTENCE ---
themeToggleBtn?.addEventListener("click", async () => {
    document.body.classList.toggle("theme-fancy");
    const currentTheme = document.body.classList.contains("theme-fancy") ? "fancy" : "plain";
    
    localStorage.setItem("chatTheme", currentTheme);
    
    try {
        await fetch("/api/save-theme", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ theme: currentTheme })
        });
    } catch (e) {
        console.error("Failed to save theme to KV", e);
    }
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
// Load voices into memory for better utterance performance
synth.getVoices();
init();

function renderContent(element, content) {
    element.innerHTML = marked.parse(content);
}

// --- SIDEBAR MANAGEMENT ---
async function updateSidebarContent() {
    try {
        const profileRes = await fetch("/api/profile", { headers: { 'x-session-id': sessionId } });
        const profileData = await profileRes.json();
        
        kvDisplay.innerHTML = `
            <div style="margin-bottom: 15px;">
                <p><strong style="color: var(--primary-color);">Profile (Cloudflare KV):</strong></p>
                <p style="font-size: 0.9rem; line-height: 1.4; opacity: 0.9;">${profileData.profile}</p>
            </div>
            
            <div style="border-top: 1px solid var(--border-color); padding: 10px 0;">
                <p><strong style="color: #60a5fa;">Insights (Cloudflare D1 SQL):</strong></p>
                <p style="font-size: 0.85rem; opacity: 0.9;">
                    <i class="ph ph-database"></i> Total Messages: <strong>${profileData.messageCount}</strong>
                </p>
            </div>

            <div style="border-top: 1px solid var(--border-color); padding-top: 10px;">
                <p><strong style="color: #a855f7;">Brain (Cloudflare Vectorize):</strong></p>
                <p style="font-size: 0.85rem; opacity: 0.9;">
                    <i class="ph ph-brain"></i> Semantic Indexing: <strong>Active</strong>
                </p>
                <p style="font-size: 0.7rem; opacity: 0.6; font-style: italic; margin-top: 4px;">
                    RAG Contextual Retrieval Enabled
                </p>
            </div>
        `;

        const filesRes = await fetch("/api/files", { headers: { 'x-session-id': sessionId } });
        const filesData = await filesRes.json();
        
        fileListDisplay.innerHTML = ""; 

        if (filesData.files && filesData.files.length > 0) {
            filesData.files.forEach(file => {
                const li = document.createElement("li");
                const fullKey = typeof file === 'string' ? file : file.key;
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
    }
}

toggleSidebarBtn?.addEventListener("click", () => {
    sidebar.classList.add("open");
    updateSidebarContent();
});

closeSidebarBtn?.addEventListener("click", () => sidebar.classList.remove("open"));

clearVectorBtn?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to wipe Jolene's memory?")) return;
    clearVectorBtn.innerText = "Wiping...";
    try {
        const res = await fetch("/api/clear-memory", { 
            method: "POST", 
            headers: { 'x-session-id': sessionId } 
        });
        if (res.ok) {
            alert("Memory cleared!");
            updateSidebarContent();
        }
    } catch (e) {
        alert("Failed to clear memory.");
    } finally {
        clearVectorBtn.innerHTML = `<i class="ph ph-warning"></i> Wipe All Knowledge`;
    }
});

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
            const successMsg = `I've successfully memorized **${file.name}**! I've indexed it into Vectorize for semantic search.`;
            addMessageToChat("assistant", successMsg);
            speak(successMsg);
            fileInput.value = ""; 
            if (sidebar.classList.contains("open")) updateSidebarContent();
        }
    } catch (e) {
        addMessageToChat("assistant", "Network error.");
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
                        
                        if (json.themeUpdate) {
                            if (json.themeUpdate === "fancy") document.body.classList.add("theme-fancy");
                            else document.body.classList.remove("theme-fancy");
                            localStorage.setItem("chatTheme", json.themeUpdate);
                        }

                        text += json.response || "";
                        renderContent(contentEl, text);
                    } catch (e) {}
                }
            }
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        
        chatHistory.push({ role: "assistant", content: text });
        if (sidebar.classList.contains("open")) updateSidebarContent();
        
        // --- VOICE TRIGGER ---
        speak(text);
        
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
