const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const modelSelector = document.getElementById("model-selector");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// Initial Theme Logic (Quick check before API loads)
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
            
            // --- SYNC THEME FROM KV ---
            // Priority: KV Data -> LocalStorage -> Default (fancy)
            const activeTheme = data.theme || localStorage.getItem("chatTheme") || "fancy";
            
            if (activeTheme === "fancy") {
                document.body.classList.add("theme-fancy");
            } else {
                document.body.classList.remove("theme-fancy");
            }
            // Keep local storage updated with the server's truth
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
    addMessageToChat('assistant', "Screen cleared! I'm ready for a fresh start. What's on your mind?");
});

// Model switch notification
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
