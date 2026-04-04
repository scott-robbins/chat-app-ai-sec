const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// 1. Basic Init
async function init() {
    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
            chatMessages.innerHTML = '';
            chatHistory = data.messages;
            chatHistory.forEach(msg => { if (msg.role !== "system") addMessageToChat(msg.role, msg.content); });
        }
    } catch (e) { console.log("No history found."); }
}
init();

// 2. Simple Message Handler
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isProcessing) return;

    isProcessing = true;
    addMessageToChat("user", message);
    userInput.value = "";
    
    if (typingIndicator) typingIndicator.classList.add("visible");
    chatHistory.push({ role: "user", content: message });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ messages: chatHistory }),
        });

        if (typingIndicator) typingIndicator.classList.remove("visible");

        if (response.headers.get("Content-Type").includes("image/png")) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            addMessageToChat("assistant", `![Vision](${url})`);
            chatHistory.push({ role: "assistant", content: "[Image Generated]" });
        } else {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const msgEl = createMessageElement("assistant");
            chatMessages.appendChild(msgEl);
            const contentEl = msgEl.querySelector(".message-content");
            
            let text = "";
            // FAIL-SAFE LOOP
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value);
                const lines = chunk.split("\n");
                
                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        const data = line.slice(6).trim();
                        if (data === "[DONE]") break;
                        try {
                            const json = JSON.parse(data);
                            text += (json.response || json.choices?.[0]?.delta?.content || "");
                            contentEl.innerHTML = marked.parse(text);
                        } catch (e) {}
                    }
                }
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
            chatHistory.push({ role: "assistant", content: text });
        }
    } catch (err) {
        addMessageToChat("assistant", "Error: " + err.message);
    } finally {
        isProcessing = false;
        if (typingIndicator) typingIndicator.classList.remove("visible");
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
    el.querySelector(".message-content").innerHTML = marked.parse(content);
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

sendButton.addEventListener("click", sendMessage);
userInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

// Theme/Clear/New Chat
document.getElementById("theme-toggle-btn")?.addEventListener("click", () => document.body.classList.toggle("theme-fancy"));
document.getElementById("new-chat-btn")?.addEventListener("click", () => { localStorage.removeItem("chatSessionId"); location.reload(); });
document.getElementById("clear-screen-btn")?.addEventListener("click", () => { chatMessages.innerHTML = ''; });
