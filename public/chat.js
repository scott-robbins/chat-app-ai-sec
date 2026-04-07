const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const fileInput = document.getElementById("file-input");
const modelSelector = document.getElementById("model-selector");

let chatHistory = [];
let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);

(function init() {
    const savedTheme = localStorage.getItem("chatTheme") || "fancy";
    document.body.className = `theme-${savedTheme}`;
})();

function toggleTheme() {
    const isFancy = document.body.classList.contains("theme-fancy");
    document.body.className = isFancy ? "theme-plain" : "theme-fancy";
    localStorage.setItem("chatTheme", isFancy ? "plain" : "fancy");
}

function openSidebar() {
    document.getElementById("memory-sidebar").classList.toggle("open");
}

function openHelp() {
    const modal = document.getElementById("help-modal");
    modal.style.display = (modal.style.display === "flex") ? "none" : "flex";
}

function clearScreen() {
    chatMessages.innerHTML = `<div class="message"><p>Screen cleared!</p></div>`;
    chatHistory = [];
}

function newChat() {
    localStorage.removeItem("chatSessionId");
    location.reload();
}

function modelChanged() {
    const name = modelSelector.options[modelSelector.selectedIndex].text;
    const msg = document.createElement("div");
    msg.innerHTML = `<p style="text-align:center; opacity:0.5; font-size:0.8rem; margin:10px 0;">— Switched to ${name} —</p>`;
    chatMessages.appendChild(msg);
}

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;
    const uDiv = document.createElement("div");
    uDiv.innerHTML = `<p style="text-align:right; color:#f6821f; margin-bottom:10px;"><b>You:</b> ${text}</p>`;
    chatMessages.appendChild(uDiv);
    userInput.value = "";
    chatHistory.push({ role: "user", content: text });

    const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": sessionId },
        body: JSON.stringify({ messages: chatHistory, model: modelSelector.value })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let aiText = "";
    const aDiv = document.createElement("div");
    chatMessages.appendChild(aDiv);

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const data = JSON.parse(line.slice(6));
                aiText += data.response;
                aDiv.innerHTML = `<p><b>Jolene:</b> ${aiText}</p>`;
            }
        }
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    chatHistory.push({ role: "assistant", content: aiText });
}

async function memorizeFile() {
    const file = fileInput.files[0];
    if (!file) return alert("Select a file.");
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/memorize", { method: "POST", headers: { "x-session-id": sessionId }, body: formData });
    if (res.ok) {
        const d = document.createElement("div");
        d.innerHTML = `<p><b>Jolene:</b> Memorized ${file.name}.</p>`;
        chatMessages.appendChild(d);
    }
}
