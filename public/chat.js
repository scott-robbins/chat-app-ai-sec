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

// Theme Logic
if (localStorage.getItem("chatTheme") === "fancy") document.body.classList.add("theme-fancy");
themeToggleBtn?.addEventListener("click", () => {
    document.body.classList.toggle("theme-fancy");
    localStorage.setItem("chatTheme", document.body.classList.contains("theme-fancy") ? "fancy" : "plain");
});

// Init - Hydrate from D1
async function init() {
    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        if (res.ok) {
            const data = await res.json();
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

async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isProcessing) return;

    isProcessing = true;
    addMessageToChat("user", message);
    userInput.value = "";
    
    typingIndicator?.classList.add("visible");
    chatMessages.scrollTop = chatMessages.scrollHeight;

    chatHistory.push({ role: "user", content: message });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "x-session-id": sessionId 
            },
            body: JSON.stringify({ 
                messages: chatHistory,
                model: modelSelector?.value || "@cf/meta/llama-3.1-8b-instruct"
            }),
        });

        typingIndicator?.classList.remove("visible");

        if (response.headers.get("Content-Type")?.includes("image/png")) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            addMessageToChat("assistant", `![Generated Image](${url})`);
            chatHistory.push({ role: "assistant", content: `[Image Generated]` });
        } 
        else {
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
                            // THE FIX: Robust JSON parsing
                            let json;
                            try {
                                json = JSON.parse(dataString);
                            } catch(e) {
                                // If already an object or weird format, skip parse
                                json = dataString; 
                            }

                            const content = (typeof json === 'object') ? (json.response || json.choices?.[0]?.delta?.content || "") : "";
                            text += content;
                            
                            if (text) contentEl.innerHTML = marked.parse(text);
                        } catch (e) {
                            console.warn("Stream parse hiccup:", e);
                        }
                    }
                }
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
            chatHistory.push({ role: "assistant", content: text });
        }
    } catch (err) {
        typingIndicator?.classList.remove("visible");
        addMessageToChat("assistant", "System Error: " + err.message);
    } finally {
        isProcessing = false;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

// Helpers
function createMessageElement(role) {
    const div = document.createElement("div");
    div.className = `message ${role}-message`;
    div.innerHTML = `<div class="message-content"></div>`;
    return div;
}

function addMessageToChat(role, content) {
    const el = createMessageElement(role);
    el.querySelector(".message-content").innerHTML = marked.parse(content);
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Event Listeners
sendButton?.addEventListener("click", sendMessage);
userInput?.addEventListener("keydown", (e) => { 
    if (e.key === "Enter" && !e.shiftKey) { 
        e.preventDefault(); 
        sendMessage(); 
    } 
});

newChatBtn?.addEventListener("click", () => {
    localStorage.removeItem("chatSessionId");
    location.reload(); 
});

clearScreenBtn?.addEventListener("click", () => {
    chatMessages.innerHTML = '';
    addMessageToChat('assistant', 'Screen cleared! Your history is still saved in D1, but the view is fresh. How can I help?');
});
