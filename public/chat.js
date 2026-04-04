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
            // CLEAR first to prevent double greetings
            chatMessages.innerHTML = ''; 
            
            if (data.messages && data.messages.length > 0) {
                chatHistory = data.messages;
                chatHistory.forEach(msg => { 
                    if (msg.role !== "system") addMessageToChat(msg.role, msg.content); 
                });
            } else {
                // Warmer, non-technical greeting
                addMessageToChat('assistant', "Hi there! I'm Jolene. I'm here to help you brainstorm, analyze files, or just chat. What's on your mind today?");
            }
        }
    } catch (e) {
        console.error("History failed to load:", e);
    }
}
init();

// Visual Feedback when Model is Switched
modelSelector?.addEventListener("change", () => {
    const selectedModelName = modelSelector.options[modelSelector.selectedIndex].text;
    addMessageToChat('assistant', `*Switched brain to **${selectedModelName}**. Our conversation continues!*`);
});

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
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ 
                messages: chatHistory,
                model: modelSelector?.value || "@cf/meta/llama-3.2-11b-vision-instruct"
            }),
        });

        if (!response.ok) throw new Error(`Server returned ${response.status}`);
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
                            let content = "";
                            try {
                                const json = JSON.parse(dataString);
                                content = json.response || json.choices?.[0]?.delta?.content || "";
                            } catch(e) {
                                content = dataString; 
                            }

                            if (typeof content === 'object' && content !== null) {
                                text += JSON.stringify(content);
                            } else {
                                text += content;
                            }

                            if (text) contentEl.innerHTML = marked.parse(text);
                        } catch (e) {}
                    }
                }
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
            chatHistory.push({ role: "assistant", content: text });
        }
    } catch (err) {
        typingIndicator?.classList.remove("visible");
        addMessageToChat("assistant", "**Error:** " + err.message);
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
    const safeContent = typeof content === 'string' ? content : JSON.stringify(content);
    el.querySelector(".message-content").innerHTML = marked.parse(safeContent);
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

sendButton?.addEventListener("click", sendMessage);
userInput?.addEventListener("keydown", (e) => { 
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } 
});

newChatBtn?.addEventListener("click", () => {
    localStorage.removeItem("chatSessionId");
    location.reload(); 
});

clearScreenBtn?.addEventListener("click", () => {
    chatMessages.innerHTML = '';
    addMessageToChat('assistant', "Screen cleared! I'm ready for a fresh start. What's on your mind?");
});
