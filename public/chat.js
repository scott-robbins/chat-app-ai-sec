const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
let chatHistory = [];
let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);

// Initialize
(function init() {
    const savedTheme = localStorage.getItem("chatTheme") || "fancy";
    document.body.className = `theme-${savedTheme}`;
})();

function toggleTheme() {
    const isFancy = document.body.classList.contains("theme-fancy");
    const newTheme = isFancy ? "plain" : "fancy";
    document.body.className = `theme-${newTheme}`;
    localStorage.setItem("chatTheme", newTheme);
}

function openSidebar() {
    const sb = document.getElementById("memory-sidebar");
    sb.classList.toggle("open");
    // You could call your /api/profile fetch here to update content
}

function openHelp() {
    const modal = document.getElementById("help-modal");
    modal.style.display = (modal.style.display === "flex") ? "none" : "flex";
}

function clearScreen() {
    chatMessages.innerHTML = `<p style="opacity:0.5; text-align:center;">--- Screen Cleared ---</p>`;
    chatHistory = [];
}

function newChat() {
    localStorage.removeItem("chatSessionId");
    location.reload();
}

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    const uMsg = document.createElement("div");
    uMsg.innerHTML = `<p style="text-align:right; color:#f6821f; margin: 10px 0;"><b>You:</b> ${text}</p>`;
    chatMessages.appendChild(uMsg);
    userInput.value = "";
    chatHistory.push({ role: "user", content: text });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ messages: chatHistory })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantText = "";
        const aMsg = document.createElement("div");
        chatMessages.appendChild(aMsg);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const data = JSON.parse(line.slice(6));
                    assistantText += data.response;
                    aMsg.innerHTML = `<p><b>Jolene:</b> ${assistantText}</p>`;
                }
            }
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        chatHistory.push({ role: "assistant", content: assistantText });
    } catch (e) { console.error(e); }
}
